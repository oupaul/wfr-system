const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const argon2 = require('argon2');
const session = require('express-session');
const { db, initDatabase, migrateBankAccountsCurrentBalance } = require('./database/db');

// 載入環境變數（如果存在 .env 檔案）
if (fs.existsSync('.env')) {
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 3000;
const APP_TITLE = process.env.APP_TITLE || '資金週報系統';
// 收入功能已重新開啟：固定為完整功能（收入 + 支出）。若需改回僅支出，改回下一行並設環境變數 TRANSACTION_MODE=expense_only
const TRANSACTION_MODE = 'full'; // 原: process.env.TRANSACTION_MODE || 'full'
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 30 * 60 * 1000; // 預設 30 分鐘

// Session 配置
app.use(session({
    secret: process.env.SESSION_SECRET || 'fund-weekly-report-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'fund-weekly-report.sid', // 自定義 session cookie 名稱
    cookie: {
        secure: false, // 開發環境不使用 HTTPS，設為 false
        httpOnly: true,
        maxAge: SESSION_TIMEOUT, // 使用配置的閒置時間
        sameSite: 'lax' // 允許跨站請求攜帶 cookie
    },
    rolling: true // 每次請求都重新計時
}));

// 中間件
app.use(cors({
    origin: true,
    credentials: true // 允許傳送 cookies
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// 處理檔案上傳的中間件
const multer = require('multer');

// 確保上傳目錄存在
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ dest: uploadsDir });

// ==================== 認證中間件 ====================

// 檢查是否已登入的中間件
const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    }
    return res.status(401).json({ error: '需要登入', authenticated: false });
};

// 檢查是否為管理員的中間件
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.userId && req.session.role === 'admin') {
        return next();
    }
    return res.status(403).json({ error: '需要管理員權限', authenticated: false });
};

// 操作日誌表建立 SQL（不加 FOREIGN KEY 避免 user_id 參考導致 INSERT 失敗）
const OPERATION_LOGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete')),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_data TEXT,
    after_data TEXT,
    summary TEXT
)`;

// 安全序列化為 JSON（避免循環引用或不可序列化導致拋錯）
function safeJsonStringify(obj) {
    if (obj == null) return null;
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return null;
    }
}

// 操作日誌：寫入一筆（先 CREATE TABLE IF NOT EXISTS 再 INSERT，不依賴遷移）
function writeOperationLog(req, action, entityType, entityId, beforeData, afterData, summary) {
    const userId = req && req.session && req.session.userId ? req.session.userId : null;
    const username = (req && req.session && req.session.username) ? req.session.username : 'system';
    const beforeStr = safeJsonStringify(beforeData);
    const afterStr = safeJsonStringify(afterData);
    const entityIdStr = entityId != null ? String(entityId) : null;
    const params = [userId, username, action, entityType, entityIdStr, beforeStr, afterStr, summary || null];
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            console.error('[操作日誌] 確保操作日誌表失敗:', createErr.message);
            return;
        }
        db.run(
            `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params,
            function(insertErr) {
                if (insertErr) {
                    console.error('[操作日誌] 寫入失敗:', insertErr.message, '| entity_type=', entityType, 'entity_id=', entityIdStr, 'action=', action);
                }
            }
        );
    });
}

// ==================== 認證 API ====================

// 檢查認證狀態
app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.userId) {
        db.get('SELECT id, username, full_name, email, role FROM users WHERE id = ? AND is_active = 1', 
            [req.session.userId], 
            (err, user) => {
                if (err || !user) {
                    req.session.destroy();
                    return res.json({ authenticated: false });
                }
                res.json({ 
                    authenticated: true, 
                    user: {
                        id: user.id,
                        username: user.username,
                        full_name: user.full_name,
                        email: user.email,
                        role: user.role
                    }
                });
            }
        );
    } else {
        res.json({ authenticated: false });
    }
});

// 登入
app.post('/api/auth/login', async (req, res) => {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '請輸入使用者名稱和密碼' });
    }

    db.get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username], async (err, user) => {
        if (err) {
            console.error('登入查詢錯誤:', err);
            return res.status(500).json({ error: '登入失敗' });
        }

        if (!user) {
            return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
        }

        try {
            // 使用 argon2 驗證密碼
            const valid = await argon2.verify(user.password_hash, password);
            
            if (!valid) {
                return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
            }

            // 設置 session
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;

            // 如果選擇記住我，延長 session 時間
            if (rememberMe) {
                req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 天
            }

            // 明確保存 session
            req.session.save((err) => {
                if (err) {
                    console.error('Session 保存錯誤:', err);
                    return res.status(500).json({ error: '登入失敗' });
                }

                // 更新最後登入時間
                db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

                res.json({ 
                    success: true, 
                    message: '登入成功',
                    user: {
                        id: user.id,
                        username: user.username,
                        full_name: user.full_name,
                        email: user.email,
                        role: user.role
                    }
                });
            });
        } catch (error) {
            console.error('密碼驗證錯誤:', error);
            return res.status(500).json({ error: '登入失敗' });
        }
    });
});

// 登出
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('登出錯誤:', err);
            return res.status(500).json({ error: '登出失敗' });
        }
        res.json({ success: true, message: '已登出' });
    });
});

// ==================== 用戶管理 API ====================

// 取得所有使用者（需要管理員權限）
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    db.all('SELECT id, username, full_name, email, role, is_active, last_login, created_at, updated_at FROM users ORDER BY created_at DESC', 
        [], 
        (err, rows) => {
            if (err) {
                console.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows });
        }
    );
});

// 取得單一使用者（需要管理員權限）
app.get('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT id, username, full_name, email, role, is_active, last_login, created_at, updated_at FROM users WHERE id = ?', 
        [id], 
        (err, row) => {
            if (err) {
                console.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到使用者' });
            }
            res.json({ data: row });
        }
    );
});

// 新增使用者（需要管理員權限）
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, full_name, email, role = 'user', is_active = 1 } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '使用者名稱和密碼為必填欄位' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: '密碼至少需要 6 個字元' });
    }

    // 檢查使用者名稱是否已存在
    db.get('SELECT id FROM users WHERE username = ?', [username], async (err, existingUser) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '新增失敗', details: err.message });
        }

        if (existingUser) {
            return res.status(400).json({ error: '使用者名稱已存在' });
        }

        try {
            // 使用 argon2id 加密密碼
            const passwordHash = await argon2.hash(password, {
                type: argon2.argon2id,
                memoryCost: 65536, // 64 MB
                timeCost: 3, // 迭代次數
                parallelism: 4 // 並行度
            });

            db.run(
                `INSERT INTO users (username, password_hash, full_name, email, role, is_active) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [username, passwordHash, full_name || null, email || null, role, is_active],
                function(err) {
                    if (err) {
                        console.error('新增錯誤:', err);
                        return res.status(500).json({ error: '新增失敗', details: err.message });
                    }
                    const newId = this.lastID;
                    const afterData = { id: newId, username, full_name: full_name || null, email: email || null, role, is_active };
                    writeOperationLog(req, 'create', 'user', newId, null, afterData, '使用者 #' + newId + ' ' + (username || ''));
                    res.json({ success: true, id: newId, message: '使用者已新增' });
                }
            );
        } catch (error) {
            console.error('密碼加密錯誤:', error);
            return res.status(500).json({ error: '新增失敗', details: error.message });
        }
    });
});

// 更新使用者（需要管理員權限）
app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { username, password, full_name, email, role, is_active } = req.body;

    db.get('SELECT id, username, full_name, email, role, is_active FROM users WHERE id = ?', [id], async (err, oldRow) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '更新失敗', details: err.message });
        }
        if (!oldRow) {
            return res.status(404).json({ error: '找不到使用者' });
        }
        if (password && password.length < 6) {
            return res.status(400).json({ error: '密碼至少需要 6 個字元' });
        }
        if (username) {
            db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, id], async (err, existingUser) => {
                if (err) {
                    console.error('查詢錯誤:', err);
                    return res.status(500).json({ error: '更新失敗', details: err.message });
                }
                if (existingUser) return res.status(400).json({ error: '使用者名稱已存在' });
                await updateUser(oldRow);
            });
        } else {
            await updateUser(oldRow);
        }

        async function updateUser(oldRow) {
            try {
                let updateFields = [];
                let params = [];
                if (username) { updateFields.push('username = ?'); params.push(username); }
                if (full_name !== undefined) { updateFields.push('full_name = ?'); params.push(full_name || null); }
                if (email !== undefined) { updateFields.push('email = ?'); params.push(email || null); }
                if (role !== undefined) { updateFields.push('role = ?'); params.push(role); }
                if (is_active !== undefined) { updateFields.push('is_active = ?'); params.push(is_active); }
                if (password) {
                    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
                    updateFields.push('password_hash = ?');
                    params.push(passwordHash);
                }
                updateFields.push('updated_at = CURRENT_TIMESTAMP');
                params.push(id);
                const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;
                db.run(query, params, function(updateErr) {
                    if (updateErr) {
                        console.error('更新錯誤:', updateErr);
                        return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                    }
                    if (this.changes === 0) return res.status(404).json({ error: '找不到使用者' });
                    const afterData = {
                        id: parseInt(id, 10),
                        username: username !== undefined ? username : oldRow.username,
                        full_name: full_name !== undefined ? (full_name || null) : oldRow.full_name,
                        email: email !== undefined ? (email || null) : oldRow.email,
                        role: role !== undefined ? role : oldRow.role,
                        is_active: is_active !== undefined ? is_active : oldRow.is_active
                    };
                    writeOperationLog(req, 'update', 'user', id, oldRow, afterData, '使用者 #' + id + ' ' + (afterData.username || ''));
                    res.json({ success: true, message: '使用者已更新' });
                });
            } catch (error) {
                console.error('更新錯誤:', error);
                return res.status(500).json({ error: '更新失敗', details: error.message });
            }
        }
    });
});

// 刪除使用者（需要管理員權限）
app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    if (parseInt(id) === req.session.userId) {
        return res.status(400).json({ error: '不能刪除自己的帳號' });
    }
    db.get('SELECT id, username, full_name, email, role, is_active, created_at, updated_at FROM users WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到使用者' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM users WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                console.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到使用者' });
            writeOperationLog(req, 'delete', 'user', id, row, null, '使用者 #' + id + ' ' + (row.username || ''));
            res.json({ success: true, message: '使用者已刪除' });
        });
    });
});

// 提供應用標題的 API（供前端使用）
app.get('/api/config', (req, res) => {
    res.json({ 
        title: APP_TITLE,
        transaction_mode: TRANSACTION_MODE // 收支模式：'full' 完整功能，'expense_only' 僅支出
    });
});

// ==================== 保護所有 API 路由（除了認證相關） ====================
// 所有 /api/* 路由都需要認證，除了 /api/auth/* 和 /api/config
app.use('/api', (req, res, next) => {
    // 排除認證相關和配置 API
    if (req.path.startsWith('/auth/') || req.path === '/config') {
        return next();
    }
    // 其他 API 都需要認證
    return requireAuth(req, res, next);
});

// ==================== 公司管理 API ====================

// 取得所有公司
app.get('/api/companies', (req, res) => {
    const { active } = req.query;
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params = [];

    if (active !== undefined) {
        query += ' AND is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY name ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得單一公司
app.get('/api/companies/:id', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        res.json({ data: row });
    });
});

// 新增公司
app.post('/api/companies', (req, res) => {
    const { 
        name, 
        code, 
        contact_person, 
        contact_phone, 
        contact_email, 
        address, 
        remarks,
        is_active 
    } = req.body;
    
    if (!name) {
        return res.status(400).json({ error: 'name 為必填欄位' });
    }

    db.run(
        `INSERT INTO companies 
         (name, code, contact_person, contact_phone, contact_email, address, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, code || null, contact_person || null, contact_phone || null, 
         contact_email || null, address || null, remarks || null, is_active !== undefined ? is_active : 1],
        function(err) {
            if (err) {
                console.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, name, code: code || null, contact_person: contact_person || null, contact_phone: contact_phone || null, contact_email: contact_email || null, address: address || null, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'company', newId, null, afterData, '公司 #' + newId + ' ' + (name || ''));
            res.json({ success: true, id: newId, message: '公司已新增' });
        }
    );
});

// 更新公司
app.put('/api/companies/:id', (req, res) => {
    const { id } = req.params;
    const { name, code, contact_person, contact_phone, contact_email, address, remarks, is_active } = req.body;
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = { id: parseInt(id, 10), name, code: code || null, contact_person: contact_person || null, contact_phone: contact_phone || null, contact_email: contact_email || null, address: address || null, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
        db.run(
            `UPDATE companies SET name = ?, code = ?, contact_person = ?, contact_phone = ?, contact_email = ?, address = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [name, code || null, contact_person || null, contact_phone || null, contact_email || null, address || null, remarks || null, is_active !== undefined ? is_active : 1, id],
            function(updateErr) {
                if (updateErr) {
                    console.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'company', id, oldRow, afterData, '公司 #' + id + ' ' + (name || ''));
                res.json({ success: true, message: '公司已更新' });
            }
        );
    });
});

// 刪除公司
app.delete('/api/companies/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM companies WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                console.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'company', id, row, null, '公司 #' + id + ' ' + (row.name || ''));
            res.json({ success: true, message: '公司已刪除' });
        });
    });
});

// ==================== 銀行帳戶管理 API ====================

// 取得所有銀行帳戶
app.get('/api/bank-accounts', (req, res) => {
    const { company_id, active } = req.query;
    let query = `
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE 1=1
    `;
    const params = [];

    if (company_id) {
        query += ' AND ba.company_id = ?';
        params.push(company_id);
    }
    if (active !== undefined) {
        query += ' AND ba.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY ba.account_name ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得單一銀行帳戶
app.get('/api/bank-accounts/:id', (req, res) => {
    const { id } = req.params;
    
    db.get(
        `SELECT ba.*, c.name as company_name 
         FROM bank_accounts ba
         LEFT JOIN companies c ON ba.company_id = c.id
         WHERE ba.id = ?`, 
        [id], 
        (err, row) => {
            if (err) {
                console.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            res.json({ data: row });
        }
    );
});

// 新增銀行帳戶
app.post('/api/bank-accounts', (req, res) => {
    const { 
        company_id, 
        account_name, 
        account_number, 
        bank_name, 
        branch_name, 
        account_type,
        currency,
        remarks,
        is_active 
    } = req.body;
    
    if (!account_name) {
        return res.status(400).json({ error: 'account_name 為必填欄位' });
    }

    db.run(
        `INSERT INTO bank_accounts 
         (company_id, account_name, account_number, bank_name, branch_name, account_type, currency, safety_level, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_id || null, account_name, account_number || null, bank_name || null, 
         branch_name || null, account_type || null, currency || 'TWD', 
         req.body.safety_level !== undefined ? req.body.safety_level : 0,
         remarks || null, is_active !== undefined ? is_active : 1],
        function(err) {
            if (err) {
                console.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level: req.body.safety_level !== undefined ? req.body.safety_level : 0, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'bank_account', newId, null, afterData, '銀行帳戶 #' + newId + ' ' + (account_name || ''));
            res.json({ success: true, id: newId, message: '銀行帳戶已新增' });
        }
    );
});

// 更新銀行帳戶
app.put('/api/bank-accounts/:id', (req, res) => {
    const { id } = req.params;
    const { company_id, account_name, account_number, bank_name, branch_name, account_type, currency, remarks, is_active } = req.body;
    const safety_level = req.body.safety_level !== undefined ? req.body.safety_level : 0;
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = { id: parseInt(id, 10), company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
        db.run(
            `UPDATE bank_accounts SET company_id = ?, account_name = ?, account_number = ?, bank_name = ?, branch_name = ?, account_type = ?, currency = ?, safety_level = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [company_id || null, account_name, account_number || null, bank_name || null, branch_name || null, account_type || null, currency || 'TWD', safety_level, remarks || null, is_active !== undefined ? is_active : 1, id],
            function(updateErr) {
                if (updateErr) {
                    console.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'bank_account', id, oldRow, afterData, '銀行帳戶 #' + id + ' ' + (account_name || ''));
                res.json({ success: true, message: '銀行帳戶已更新' });
            }
        );
    });
});

// 刪除銀行帳戶
app.delete('/api/bank-accounts/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM bank_accounts WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                console.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'bank_account', id, row, null, '銀行帳戶 #' + id + ' ' + (row.account_name || ''));
            res.json({ success: true, message: '銀行帳戶已刪除' });
        });
    });
});

// 重新計算所有銀行帳戶即時餘額（依結算+交易重算，修正既有資料）
app.post('/api/bank-accounts/recalculate-balances', async (req, res) => {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT ba.account_name, ba.account_number, c.name as company_name
                FROM bank_accounts ba
                LEFT JOIN companies c ON ba.company_id = c.id
                WHERE ba.is_active = 1
            `, [], (err, r) => err ? reject(err) : resolve(r || []));
        });
        for (const row of rows) {
            await updateBankAccountBalance(row.account_name, row.account_number, row.company_name || null);
        }
        res.json({ success: true, message: `已重新計算 ${rows.length} 個帳戶餘額` });
    } catch (err) {
        console.error('重新計算餘額錯誤:', err);
        res.status(500).json({ error: '重新計算失敗', details: err.message });
    }
});

// 確保 HTML 文件可以正確訪問
app.get('/manage.html', (req, res) => {
    res.redirect('/cash-gap-dashboard.html');
});
app.get('/cash-gap-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cash-gap-dashboard.html'));
});
app.get('/transactions.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'transactions.html'));
});
app.get('/settlement.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settlement.html'));
});
app.get('/companies.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'companies.html'));
});
app.get('/bank-accounts.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bank-accounts.html'));
});

// 初始化資料庫，完成後確保 operation_logs 表存在並寫入一筆啟動日誌以驗證寫入路徑
function ensureOperationLogsAndWriteStartupLog() {
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            console.error('[操作日誌] 啟動時確保表失敗:', createErr.message);
            return;
        }
        db.run(
            `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [null, 'system', 'create', 'system', null, null, null, '系統啟動'],
            function(insertErr) {
                if (insertErr) {
                    const isFk = /foreign key|FOREIGN KEY/i.test(insertErr.message);
                    if (isFk) {
                        console.warn('[操作日誌] 啟動寫入失敗（疑似舊表含 FOREIGN KEY），嘗試重建表…');
                        db.run('DROP TABLE IF EXISTS operation_logs', [], function(dropErr) {
                            if (dropErr) {
                                console.error('[操作日誌] 重建表失敗:', dropErr.message);
                                return;
                            }
                            db.run(OPERATION_LOGS_TABLE_SQL, [], function(create2Err) {
                                if (create2Err) {
                                    console.error('[操作日誌] 重建表失敗:', create2Err.message);
                                    return;
                                }
                                db.run(
                                    `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [null, 'system', 'create', 'system', null, null, null, '系統啟動'],
                                    function(insert2Err) {
                                        if (insert2Err) console.error('[操作日誌] 重建後寫入仍失敗:', insert2Err.message);
                                        else console.log('[操作日誌] 表已重建，啟動日誌已寫入');
                                    }
                                );
                            });
                        });
                    } else {
                        console.error('[操作日誌] 啟動測試寫入失敗:', insertErr.message);
                    }
                } else {
                    console.log('[操作日誌] 表已就緒，啟動日誌已寫入');
                }
            }
        );
    });
}
initDatabase().then(() => ensureOperationLogsAndWriteStartupLog()).catch(console.error);

// API 路由

// 資金缺口通報儀表板 API
app.get('/api/cash-gap-dashboard', (req, res) => {
    const { forecastDays = 28 } = req.query; // 預設預測未來28天（4週）
    const today = new Date().toISOString().split('T')[0];
    const forecastEndDate = new Date(Date.now() + parseInt(forecastDays) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    // 取得所有啟用的帳戶
    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
        ORDER BY c.name, ba.account_name
    `, [], (err, accounts) => {
        if (err) {
            console.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        
        // 對每個帳戶計算資金缺口
        const dashboardData = [];
        let processedCount = 0;
        
        if (accounts.length === 0) {
            return res.json({ data: [], summary: { totalAccounts: 0, totalBalance: 0, gapAccounts: 0, nearestGapDate: null, totalGap: 0, currentDate: today } });
        }
        
        accounts.forEach((account, index) => {
            // 取得結算作為期初餘額：優先「同公司＋同帳戶」的結算，避免多帳戶公司誤用公司級期初
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                account.company_name || '',
                account.account_name || null,
                account.account_number || null,
                account.account_name || null,
                account.account_number || null,
                account.account_number || null
            ], (err, settlement) => {
                if (err) {
                    console.error('查詢結算記錄錯誤:', err);
                }
                
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                
                // 計算從上次結算日到今天的收支（如果有結算記錄）
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';
                
                // 計算未來期間的預計收支（僅計入該帳戶的交易；嚴格比對 account_number，避免同公司同名帳戶時 NULL 被重複計入）
                db.all(`
                    SELECT 
                        type,
                        SUM(CASE WHEN transaction_date >= ? AND transaction_date <= ? THEN amount ELSE 0 END) as future_amount,
                        COUNT(CASE WHEN transaction_date >= ? AND transaction_date <= ? THEN 1 ELSE NULL END) as future_count
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    GROUP BY type
                `, [today, forecastEndDate, today, forecastEndDate, 
                    account.company_name || '', account.account_name || null, account.account_number || null, account.account_number || null,
                    startDate, forecastEndDate], (err, futureTransactions) => {
                    if (err) {
                        console.error('查詢未來交易錯誤:', err);
                    }
                    
                    // 計算已發生的收支（從上次結算到今天含今天，僅計入該帳戶的交易；嚴格比對 account_number）
                    db.all(`
                        SELECT 
                            type,
                            SUM(amount) as total_amount
                        FROM transactions
                        WHERE company_name = ?
                          AND account_name = ?
                          AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                          AND transaction_date >= ?
                          AND transaction_date <= ?
                        GROUP BY type
                    `, [account.company_name || '', account.account_name || null, account.account_number || null, account.account_number || null,
                        startDate, today], (err, pastTransactions) => {
                        if (err) {
                            console.error('查詢過去交易錯誤:', err);
                        }
                        
                        let pastIncome = 0;
                        let pastExpense = 0;
                        pastTransactions?.forEach(t => {
                            if (t.type === 'income') pastIncome += parseFloat(t.total_amount) || 0;
                            else pastExpense += parseFloat(t.total_amount) || 0;
                        });
                        
                        let futureIncome = 0;
                        let futureExpense = 0;
                        futureTransactions?.forEach(t => {
                            if (t.type === 'income') futureIncome += parseFloat(t.future_amount) || 0;
                            else futureExpense += parseFloat(t.future_amount) || 0;
                        });
                        
                        // 計算當前餘額
                        const currentBalance = openingBalance + pastIncome - pastExpense;
                        
                        // 計算預計期末餘額
                        const projectedBalance = currentBalance + futureIncome - futureExpense;
                        
                        // 安全水位
                        const safetyLevel = parseFloat(account.safety_level) || 0;
                        
                        // 計算資金缺口
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        const isGap = gap > 0;
                        
                        // 計算資金缺口發生日期
                        // 如果當前餘額已經低於安全水位，缺口日期為今天
                        // 否則需要計算從今天到預測結束日期之間，哪天會首次低於安全水位
                        let gapDate = null;
                        if (isGap) {
                            if (currentBalance < safetyLevel) {
                                // 當前餘額已低於安全水位，缺口日期為今天
                                gapDate = today;
                            } else {
                                // 當前餘額還高於安全水位，但預計未來會出現缺口
                                // 計算淨現金流（每日平均）
                                const netCashFlow = futureIncome - futureExpense;
                                const daysToForecast = parseInt(forecastDays);
                                
                                if (netCashFlow < 0 && daysToForecast > 0) {
                                    // 負的淨現金流，計算日均支出
                                    const dailyNetFlow = Math.abs(netCashFlow) / daysToForecast;
                                    const balanceBuffer = currentBalance - safetyLevel;
                                    if (dailyNetFlow > 0) {
                                        const daysToGap = Math.ceil(balanceBuffer / dailyNetFlow);
                                        if (daysToGap > 0 && daysToGap <= daysToForecast) {
                                            const gapDateObj = new Date(Date.now() + daysToGap * 24 * 60 * 60 * 1000);
                                            gapDate = gapDateObj.toISOString().split('T')[0];
                                        } else {
                                            gapDate = forecastEndDate;
                                        }
                                    } else {
                                        gapDate = forecastEndDate;
                                    }
                                } else {
                                    // 正的淨現金流或零，使用預測結束日期（理論上不應該出現缺口，但以防萬一）
                                    gapDate = forecastEndDate;
                                }
                            }
                        }
                        
                        dashboardData.push({
                            account_id: account.id,
                            company_name: account.company_name || '',
                            account_name: account.account_name || '',
                            account_number: account.account_number || '',
                            opening_balance: openingBalance,
                            current_balance: currentBalance,
                            past_income: pastIncome,
                            past_expense: pastExpense,
                            future_income: futureIncome,
                            future_expense: futureExpense,
                            projected_balance: projectedBalance,
                            safety_level: safetyLevel,
                            gap: gap,
                            is_gap: isGap,
                            gap_date: gapDate,
                            last_settlement_date: settlement?.settlement_date || null
                        });
                        
                        processedCount++;
                        if (processedCount === accounts.length) {
                            // 計算摘要
                            const gapAccounts = dashboardData.filter(d => d.is_gap);
                            const totalGap = dashboardData.reduce((sum, d) => sum + d.gap, 0);
                            // 計算所有帳戶的當前餘額加總（使用系統當天日期作為截止日）
                            const totalBalance = dashboardData.reduce((sum, d) => sum + (d.current_balance || 0), 0);
                            
                            // 計算最近資金缺口日期（找出所有有缺口帳戶中最早的缺口日期）
                            let nearestGapDate = null;
                            if (gapAccounts.length > 0) {
                                const gapDates = gapAccounts
                                    .map(d => d.gap_date)
                                    .filter(date => date !== null)
                                    .sort();
                                if (gapDates.length > 0) {
                                    nearestGapDate = gapDates[0]; // 最早的日期
                                }
                            }
                            
                            res.json({
                                data: dashboardData,
                                summary: {
                                    totalAccounts: accounts.length,
                                    totalBalance: totalBalance,
                                    gapAccounts: gapAccounts.length,
                                    nearestGapDate: nearestGapDate,
                                    totalGap: totalGap,
                                    forecastDays: parseInt(forecastDays),
                                    forecastEndDate: forecastEndDate,
                                    currentDate: today
                                }
                            });
                        }
                    });
                });
            });
        });
    });
});

// 資金缺口：未來三個月的每個月 10 號、25 號（當月、次月、再次月，共 6 個日期）
function toLocalDateStr(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

function buildMonthlyTargetDates() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const y = today.getFullYear();
    const m = today.getMonth();
    const out = [];
    for (let i = 0; i < 3; i++) {
        const d10 = new Date(y, m + i, 10);
        const d25 = new Date(y, m + i, 25);
        if (d10 >= today) out.push(toLocalDateStr(d10));
        if (d25 >= today) out.push(toLocalDateStr(d25));
    }
    return out.sort();
}

app.get('/api/cash-gap-dashboard-by-dates', (req, res) => {
    const now = new Date();
    const today = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const targetDates = buildMonthlyTargetDates();
    const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;

    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
        ORDER BY c.name, ba.account_name
    `, [], (err, accounts) => {
        if (err) {
            console.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (accounts.length === 0) {
            return res.json({
                targetDates: targetDates,
                data: [],
                summary: { totalBalance: 0, totalGapByDate: {} }
            });
        }

        const dashboardData = [];
        let processedCount = 0;

        accounts.forEach((account) => {
            // 優先取「同公司＋同帳戶」的結算；若無則再取公司級(account_name/account_number 為 NULL)，避免A公司等多帳戶公司誤用公司級期初
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                account.company_name || '',
                account.account_name || null,
                account.account_number || null,
                account.account_name || null,
                account.account_number || null,
                account.account_number || null
            ], (err, settlement) => {
                if (err) {
                    console.error('查詢結算記錄錯誤:', err);
                }
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';

                // 嚴格比對 account_number，避免同公司同名帳戶（如A公司-華南）時 account_number 為 NULL 的交易被重複計入
                db.all(`
                    SELECT transaction_date, type, amount
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    ORDER BY transaction_date
                `, [
                    account.company_name || '',
                    account.account_name || null,
                    account.account_number || null,
                    account.account_number || null,
                    startDate,
                    maxDate
                ], (err, rows) => {
                    if (err) {
                        console.error('查詢交易錯誤:', err);
                    }
                    const safetyLevel = parseFloat(account.safety_level) || 0;
                    const byDate = targetDates.map((dateStr) => {
                        let income = 0, expense = 0;
                        (rows || []).forEach((r) => {
                            if (r.transaction_date > dateStr) return;
                            const amt = parseFloat(r.amount) || 0;
                            if (r.type === 'income') income += amt;
                            else expense += amt;
                        });
                        const projectedBalance = openingBalance + income - expense;
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        return { date: dateStr, income_sum: income, expense_sum: expense, projected_balance: projectedBalance, gap };
                    });
                    let currentBalance = openingBalance;
                    (rows || []).forEach((r) => {
                        if (r.transaction_date > today) return;
                        const amt = parseFloat(r.amount) || 0;
                        if (r.type === 'income') currentBalance += amt;
                        else currentBalance -= amt;
                    });

                    dashboardData.push({
                        account_id: account.id,
                        company_name: account.company_name || '',
                        account_name: account.account_name || '',
                        account_number: account.account_number || '',
                        opening_balance: openingBalance,
                        current_balance: currentBalance,
                        safety_level: safetyLevel,
                        last_settlement_date: settlement?.settlement_date || null,
                        transaction_count: (rows || []).length,
                        by_date: byDate
                    });

                    processedCount++;
                    if (processedCount === accounts.length) {
                        const totalBalance = dashboardData.reduce((s, d) => s + (d.current_balance || 0), 0);
                        const totalGapByDate = {};
                        targetDates.forEach((d) => {
                            totalGapByDate[d] = dashboardData.reduce((s, a) => s + (a.by_date.find((x) => x.date === d)?.gap || 0), 0);
                        });
                        res.json({
                            targetDates,
                            data: dashboardData,
                            summary: {
                                totalBalance,
                                totalGapByDate,
                                currentDate: today
                            }
                        });
                    }
                });
            });
        });
    });
});

// 資金缺口對帳 API：回傳指定公司/帳戶的期初、各日收入/支出合計與預計餘額，供與 Excel 比對
app.get('/api/cash-gap-reconciliation', (req, res) => {
    const company = (req.query.company || '').trim();
    const account = (req.query.account || '').trim();
    const now = new Date();
    const today = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const targetDates = buildMonthlyTargetDates();
    const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;

    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
          AND (? = '' OR c.name = ? OR c.name LIKE ?)
          AND (? = '' OR ba.account_name = ? OR ba.account_name LIKE ?)
        ORDER BY c.name, ba.account_name
    `, [company, company, company ? `%${company}%` : '%', account, account, account ? `%${account}%` : '%'], (err, accounts) => {
        if (err) {
            console.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (accounts.length === 0) {
            return res.json({
                targetDates,
                currentDate: today,
                data: [],
                note: '系統計算：預計餘額 = 期初餘額 + 收入合計 - 支出合計；資金缺口 = 安全水位 - 預計餘額（若預計餘額 < 安全水位）。期初餘額來自「結算」功能，請確認與 Excel 的期初一致。'
            });
        }

        const result = [];
        let done = 0;
        accounts.forEach((acc) => {
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                acc.company_name || '', acc.account_name || null, acc.account_number || null,
                acc.account_name || null, acc.account_number || null, acc.account_number || null
            ], (err, settlement) => {
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';
                db.all(`
                    SELECT transaction_date, type, amount
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    ORDER BY transaction_date
                `, [
                    acc.company_name || '', acc.account_name || null, acc.account_number || null, acc.account_number || null,
                    startDate, maxDate
                ], (err, rows) => {
                    if (err) {
                        done++;
                        if (done === accounts.length) res.json({ targetDates, currentDate: today, data: result });
                        return;
                    }
                    const safetyLevel = parseFloat(acc.safety_level) || 0;
                    const byDate = targetDates.map((dateStr) => {
                        let income = 0, expense = 0;
                        (rows || []).forEach((r) => {
                            if (r.transaction_date > dateStr) return;
                            const amt = parseFloat(r.amount) || 0;
                            if (r.type === 'income') income += amt;
                            else expense += amt;
                        });
                        const projectedBalance = openingBalance + income - expense;
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        return { date: dateStr, income_sum: income, expense_sum: expense, projected_balance: projectedBalance, gap };
                    });
                    result.push({
                        account_id: acc.id,
                        company_name: acc.company_name || '',
                        account_name: acc.account_name || '',
                        account_number: acc.account_number || '',
                        opening_balance: openingBalance,
                        settlement_date: settlement?.settlement_date || null,
                        safety_level: safetyLevel,
                        transaction_count: (rows || []).length,
                        by_date: byDate
                    });
                    done++;
                    if (done === accounts.length) {
                        res.json({
                            targetDates,
                            currentDate: today,
                            data: result,
                            note: '預計餘額 = 期初餘額 + 收入合計 - 支出合計。資金缺口 = 安全水位 - 預計餘額（當預計餘額 < 安全水位）。請確認 Excel 的期初餘額與系統「結算」一致，且公司/帳戶/帳號與系統完全一致。'
                        });
                    }
                });
            });
        });
    });
});

// 取得匯入記錄（保留，因為可能與收支記錄匯入功能相關）
app.get('/api/import-logs', (req, res) => {
    const limit = req.query.limit || 20;
    
    db.all(
        'SELECT * FROM import_logs ORDER BY imported_at DESC LIMIT ?',
        [limit],
        (err, rows) => {
            if (err) {
                console.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows });
        }
    );
});

// ==================== 收支記錄 API ====================

// 取得所有收支記錄
app.get('/api/transactions', (req, res) => {
    const { startDate, endDate, type, company, account, limit = 1000, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' ORDER BY transaction_date DESC, id DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 下載匯入範本 Excel（必須在 /api/transactions/:id 之前）
app.get('/api/transactions/template', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('收支記錄範本');

        // 設定欄位寬度
        worksheet.columns = [
            { header: '日期', key: 'date', width: 15 },
            { header: '說明', key: 'description', width: 40 },
            { header: '類型', key: 'type', width: 10 },
            { header: '金額', key: 'amount', width: 15 },
            { header: '類別', key: 'category', width: 20 },
            { header: '公司名稱', key: 'company', width: 25 },
            { header: '帳戶名稱', key: 'account', width: 25 },
            { header: '帳號', key: 'accountNumber', width: 20 },
            { header: '備註', key: 'remarks', width: 30 }
        ];

        // 設定標題行樣式
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

        // 添加說明行（第二行，合併單元格）
        const noteRow = worksheet.addRow([]);
        worksheet.mergeCells('A2:I2');
        noteRow.getCell(1).value = '說明：日期支援民國年格式（如：115/01/01）或西元年格式（如：2026/01/01）。金額可用括號表示負數（表示支出）。類型欄位可填「收入」或「支出」，如不填寫，系統會根據金額正負自動判斷。';
        noteRow.getCell(1).font = { size: 10, color: { argb: 'FF666666' }, italic: true };
        noteRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        noteRow.height = 40;

        // 添加範例資料
        const today = new Date();
        const rocYear = today.getFullYear() - 1911;
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const exampleDate = `${rocYear}/${month}/${day}`;

        // 範例1：收入
        const row1 = worksheet.addRow({
            date: exampleDate,
            description: '範例：薪資收入',
            type: '收入',
            amount: 50000,
            category: '薪資',
            company: '範例公司',
            account: '台灣銀行',
            accountNumber: '1234567890',
            remarks: '這是收入範例'
        });

        // 範例2：支出
        const row2 = worksheet.addRow({
            date: exampleDate,
            description: '範例：辦公室租金',
            type: '支出',
            amount: 30000,
            category: '租金',
            company: '範例公司',
            account: '台灣銀行',
            accountNumber: '1234567890',
            remarks: '這是支出範例'
        });

        // 設定金額欄位格式
        row1.getCell('amount').numFmt = '#,##0';
        row2.getCell('amount').numFmt = '#,##0_);(#,##0)'; // 負數用括號
        row2.getCell('amount').value = -30000; // 設定為負數
        row2.getCell('amount').font = { color: { argb: 'FFFF0000' } }; // 紅色

        // 設定日期欄位格式
        row1.getCell('date').alignment = { horizontal: 'center' };
        row2.getCell('date').alignment = { horizontal: 'center' };

        // 設定檔名
        const fileName = `收支記錄匯入範本.xlsx`;

        // 設定回應標頭
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

        // 寫入回應
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('生成範本錯誤:', error);
        res.status(500).json({ error: '生成範本失敗', details: error.message });
    }
});

// 匯出收支記錄為 Excel（必須在 /api/transactions/:id 之前）
app.get('/api/transactions/export', (req, res) => {
    const { startDate, endDate, type, company, account } = req.query;
    
    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' ORDER BY transaction_date ASC, id ASC';

    db.all(query, params, async (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }

        try {
            // 建立 Excel 工作簿
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('收支記錄');

            // 設定欄位寬度
            worksheet.columns = [
                { header: '日期', key: 'date', width: 12 },
                { header: '說明', key: 'description', width: 50 },
                { header: '金額1', key: 'amount1', width: 15 },
                { header: '金額2', key: 'amount2', width: 15 },
                { header: '金額3', key: 'amount3', width: 15 },
                { header: '金額4', key: 'amount4', width: 15 },
                { header: '類型', key: 'type', width: 10 },
                { header: '類別', key: 'category', width: 20 },
                { header: '公司名稱', key: 'company', width: 25 },
                { header: '帳戶名稱', key: 'account', width: 25 },
                { header: '帳號', key: 'accountNumber', width: 20 },
                { header: '備註', key: 'remarks', width: 30 }
            ];

            // 設定標題行樣式
            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E0E0' }
            };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

            // 將日期從西元年轉換為民國年（用於顯示）
            function toROCYear(dateStr) {
                if (!dateStr) return '';
                const date = new Date(dateStr);
                const year = date.getFullYear();
                const rocYear = year - 1911;
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${rocYear}/${month}/${day}`;
            }

            // 填寫資料
            rows.forEach((row, index) => {
                const dataRow = worksheet.addRow({
                    date: toROCYear(row.transaction_date),
                    description: row.description || '',
                    amount1: row.type === 'expense' ? -Math.abs(row.amount) : (row.type === 'income' ? Math.abs(row.amount) : ''),
                    amount2: '',
                    amount3: '',
                    amount4: '',
                    type: row.type === 'income' ? '收入' : '支出',
                    category: row.category || '',
                    company: row.company_name || '',
                    account: row.account_name || '',
                    accountNumber: row.account_number || '',
                    remarks: row.remarks || ''
                });

                // 設定金額欄位格式（負數用括號表示）
                const amountCell = dataRow.getCell('amount1');
                if (amountCell.value !== '') {
                    if (row.type === 'expense') {
                        amountCell.numFmt = '#,##0_);(#,##0)'; // 負數用括號
                        amountCell.font = { color: { argb: 'FFFF0000' } }; // 紅色
                    } else {
                        amountCell.numFmt = '#,##0';
                    }
                }

                // 設定日期欄位格式
                dataRow.getCell('date').alignment = { horizontal: 'center' };
            });

            // 設定檔名
            const fileName = `收支記錄_${new Date().toISOString().split('T')[0]}.xlsx`;

            // 設定回應標頭
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

            // 寫入回應
            await workbook.xlsx.write(res);
            res.end();
        } catch (error) {
            console.error('匯出錯誤:', error);
            res.status(500).json({ error: '匯出失敗', details: error.message });
        }
    });
});

// 取得收支統計（必須在 /api/transactions/:id 之前）
app.get('/api/transactions/statistics', (req, res) => {
    const { startDate, endDate, company, account } = req.query;
    
    let query = 'SELECT type, SUM(amount) as total_amount FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' GROUP BY type';

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows });
    });
});

// 取得單一收支記錄
app.get('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        res.json({ data: row });
    });
});

// ==================== 銀行帳戶餘額更新輔助函數 ====================

// 更新銀行帳戶的即時餘額
// 根據最近的餘額結算記錄 + 結算日～「當天」的收支記錄計算（即時餘額只統計到當天）
async function updateBankAccountBalance(accountName, accountNumber = null, companyName = null) {
    return new Promise((resolve, reject) => {
        if (!accountName) {
            return resolve(); // 如果沒有指定帳戶，不更新
        }
        const today = new Date().toISOString().split('T')[0]; // 只統計到當天

        // 查找銀行帳戶：有公司名時依公司+帳戶精確匹配；無則依帳戶並帶出該帳戶所屬公司（相容舊資料／未選公司）
        let accountQuery, accountParams;
        if (companyName) {
            accountQuery = `
                SELECT ba.id, ? as resolved_company FROM bank_accounts ba
                INNER JOIN companies c ON ba.company_id = c.id
                WHERE c.name = ? AND ba.account_name = ? AND ba.is_active = 1
                ${accountNumber ? 'AND (ba.account_number = ? OR ba.account_number IS NULL)' : ''}
            `;
            accountParams = accountNumber ? [companyName, companyName, accountName, accountNumber] : [companyName, companyName, accountName];
        } else {
            accountQuery = `
                SELECT ba.id, c.name as resolved_company FROM bank_accounts ba
                LEFT JOIN companies c ON ba.company_id = c.id
                WHERE ba.account_name = ? AND ba.is_active = 1
                ${accountNumber ? 'AND (ba.account_number = ? OR ba.account_number IS NULL)' : ''}
                LIMIT 1
            `;
            accountParams = accountNumber ? [accountName, accountNumber] : [accountName];
        }

        db.get(accountQuery, accountParams, (err, account) => {
            if (err) {
                console.error('查詢銀行帳戶錯誤:', err);
                return reject(err);
            }

            if (!account) {
                return resolve();
            }

            const resolvedCompany = companyName || account.resolved_company || null;

            // 查找該帳戶最近的餘額結算記錄（有公司名時一併篩選）
            const settleWhere = resolvedCompany
                ? 'company_name = ? AND account_name = ? ' + (accountNumber ? 'AND (account_number = ? OR account_number IS NULL)' : '')
                : 'account_name = ? ' + (accountNumber ? 'AND account_number = ?' : '');
            const settleParams = resolvedCompany
                ? (accountNumber ? [resolvedCompany, accountName, accountNumber] : [resolvedCompany, accountName])
                : (accountNumber ? [accountName, accountNumber] : [accountName]);

            db.get(
                `SELECT settlement_date, actual_balance 
                 FROM balance_settlements 
                 WHERE ${settleWhere}
                 ORDER BY settlement_date DESC 
                 LIMIT 1`,
                settleParams,
                (err, settlement) => {
                    if (err) {
                        console.error('查詢餘額結算錯誤:', err);
                        return reject(err);
                    }

                    let startBalance = 0;
                    let startDate = '1900-01-01';
                    if (settlement) {
                        startBalance = parseFloat(settlement.actual_balance) || 0;
                        startDate = settlement.settlement_date;
                    }

                    // 只統計結算日～當天的交易（即時餘額不包含未來日期的收支）
                    const transWhere = resolvedCompany
                        ? '(company_name = ? OR company_name IS NULL) AND account_name = ? AND transaction_date >= ? AND transaction_date <= ? ' + (accountNumber ? 'AND (account_number = ? OR account_number IS NULL)' : '')
                        : 'account_name = ? AND transaction_date >= ? AND transaction_date <= ? ' + (accountNumber ? 'AND account_number = ?' : '');
                    const transParams = resolvedCompany
                        ? (accountNumber ? [resolvedCompany, accountName, startDate, today, accountNumber] : [resolvedCompany, accountName, startDate, today])
                        : (accountNumber ? [accountName, startDate, today, accountNumber] : [accountName, startDate, today]);

                    const transQuery = `
                        SELECT type, SUM(amount) as total
                        FROM transactions
                        WHERE ${transWhere}
                        GROUP BY type
                    `;

                    db.all(transQuery, transParams, (err, transactions) => {
                        if (err) {
                            console.error('查詢交易記錄錯誤:', err);
                            return reject(err);
                        }

                        let currentBalance = startBalance;
                        (transactions || []).forEach(trans => {
                            const tot = parseFloat(trans.total) || 0;
                            if (trans.type === 'income') currentBalance += tot;
                            else if (trans.type === 'expense') currentBalance -= tot;
                        });

                        db.run(
                            'UPDATE bank_accounts SET current_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            [currentBalance, account.id],
                            (err) => {
                                if (err) {
                                    console.error('更新帳戶餘額錯誤:', err);
                                    return reject(err);
                                }
                                console.log(`✓ 已更新帳戶 ${accountName} 的即時餘額: ${currentBalance}`);
                                resolve();
                            }
                        );
                    });
                }
            );
        });
    });
}

// 新增收支記錄
app.post('/api/transactions', (req, res) => {
    const { 
        transaction_date, 
        type, 
        amount, 
        category,
        description,
        company_name, 
        account_name, 
        account_number, 
        remarks 
    } = req.body;
    
    if (!transaction_date || !type || amount === undefined) {
        return res.status(400).json({ error: 'transaction_date、type 和 amount 為必填欄位' });
    }
    
    if (type !== 'income' && type !== 'expense') {
        return res.status(400).json({ error: 'type 必須是 income 或 expense' });
    }

    db.run(
        `INSERT INTO transactions 
         (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [transaction_date, type, amount, category || null, description || null, 
         company_name || null, account_name || null, account_number || null, remarks || null],
        async function(err) {
            if (err) {
                console.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            
            const newId = this.lastID;
            const afterData = { id: newId, transaction_date, type, amount, category: category || null, description: description || null, company_name: company_name || null, account_name: account_name || null, account_number: account_number || null, remarks: remarks || null };
            writeOperationLog(req, 'create', 'transaction', newId, null, afterData, '收支記錄 #' + newId);
            try {
                if (account_name) {
                    await updateBankAccountBalance(account_name, account_number, company_name || null);
                }
            } catch (error) {
                console.error('更新帳戶餘額失敗:', error);
            }
            res.json({ success: true, id: newId, message: '記錄已新增' });
        }
    );
});

// 更新收支記錄
app.put('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const { 
        transaction_date, 
        type, 
        amount, 
        category,
        description,
        company_name, 
        account_name, 
        account_number, 
        remarks 
    } = req.body;
    
    if (type && type !== 'income' && type !== 'expense') {
        return res.status(400).json({ error: 'type 必須是 income 或 expense' });
    }
    
    // 先獲取舊的交易記錄（含公司名以正確更新餘額，及完整列供操作日誌）
    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, oldRow) => {
        if (err) {
            console.error('查詢舊記錄錯誤:', err);
            return res.status(500).json({ error: '更新失敗', details: err.message });
        }
        if (!oldRow) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const oldTransaction = oldRow;
        const afterData = { id: parseInt(id, 10), transaction_date, type, amount, category: category || null, description: description || null, company_name: company_name || null, account_name: account_name || null, account_number: account_number || null, remarks: remarks || null };
        // 執行更新
        db.run(
            `UPDATE transactions 
             SET transaction_date = ?, type = ?, amount = ?, category = ?, description = ?,
                 company_name = ?, account_name = ?, account_number = ?, remarks = ?, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [transaction_date, type, amount, category || null, description || null,
             company_name || null, account_name || null, account_number || null, remarks || null, id],
            async function(err) {
                if (err) {
                    console.error('更新錯誤:', err);
                    return res.status(500).json({ error: '更新失敗', details: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: '找不到記錄' });
                }
                writeOperationLog(req, 'update', 'transaction', id, oldRow, afterData, '收支記錄 #' + id);
                try {
                    const accountChanged = oldTransaction.account_name !== account_name || oldTransaction.account_number !== account_number;
                    if (accountChanged && oldTransaction.account_name) {
                        await updateBankAccountBalance(oldTransaction.account_name, oldTransaction.account_number, oldTransaction.company_name || null);
                    }
                    if (account_name) {
                        await updateBankAccountBalance(account_name, account_number, company_name || null);
                    }
                } catch (error) {
                    console.error('更新帳戶餘額失敗:', error);
                }
                res.json({ success: true, message: '記錄已更新' });
            }
        );
    });
});

// 批次刪除收支記錄（必須在 /api/transactions/:id 之前）
app.post('/api/transactions/batch-delete', async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: '請提供要刪除的記錄 id 陣列 (ids)' });
    }
    const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    if (numericIds.length === 0) {
        return res.status(400).json({ error: 'ids 格式錯誤' });
    }
    let deletedCount = 0;
    const placeholders = numericIds.map(() => '?').join(',');
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT * FROM transactions WHERE id IN (${placeholders})`,
                numericIds,
                (err, r) => (err ? reject(err) : resolve(r || []))
            );
        });
        for (const row of rows) {
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM transactions WHERE id = ?', [row.id], function(err) {
                    if (err) return reject(err);
                    deletedCount += this.changes;
                    if (this.changes > 0) {
                        writeOperationLog(req, 'delete', 'transaction', row.id, row, null, '收支記錄 #' + row.id);
                    }
                    resolve();
                });
            });
            try {
                if (row.account_name) {
                    await updateBankAccountBalance(row.account_name, row.account_number, row.company_name || null);
                }
            } catch (e) {
                console.error('更新帳戶餘額失敗:', e);
            }
        }
        res.json({ success: true, message: `已刪除 ${deletedCount} 筆記錄`, deletedCount });
    } catch (err) {
        console.error('批次刪除錯誤:', err);
        res.status(500).json({ error: '批次刪除失敗', details: err.message });
    }
});

// 刪除收支記錄
app.delete('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('查詢記錄錯誤:', err);
            return res.status(500).json({ error: '刪除失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const transaction = row;
        db.run('DELETE FROM transactions WHERE id = ?', [id], async function(err) {
            if (err) {
                console.error('刪除錯誤:', err);
                return res.status(500).json({ error: '刪除失敗', details: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            writeOperationLog(req, 'delete', 'transaction', id, transaction, null, '收支記錄 #' + id);
            try {
                if (transaction.account_name) {
                    await updateBankAccountBalance(transaction.account_name, transaction.account_number, transaction.company_name || null);
                }
            } catch (error) {
                console.error('更新帳戶餘額失敗:', error);
            }
            res.json({ success: true, message: '記錄已刪除' });
        });
    });
});

// 匯入收支記錄 Excel
app.post('/api/transactions/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '請選擇要匯入的檔案' });
    }

    const filePath = req.file.path;
    const errors = [];
    let importedCount = 0;
    let skippedCount = 0;

    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        const worksheet = workbook.worksheets[0];

        // 將儲存格值轉成字串（避免 Excel 富文本等物件變成 [object Object]）
        function getCellText(value) {
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') {
                if (Array.isArray(value.richText)) {
                    return value.richText.map(t => (t && t.text) ? t.text : '').join('').trim();
                }
                if (typeof value.text === 'string') return value.text.trim();
                if (value.result !== undefined && value.result !== null) return getCellText(value.result);
            }
            return String(value).trim();
        }
        
        // 讀取標題行（假設第一行是標題）
        const headerRow = worksheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            headers[colNumber - 1] = getCellText(cell.value);
        });

        // 將民國年轉換為西元年（支援 115/2/10、115/02/10、1150210 等格式）
        function fromROCYear(rocDateStr) {
            if (!rocDateStr) return null;
            const str = String(rocDateStr).trim();
            // 格式：115/01/01、115/2/10（月日可單數字）、1150101、1150210
            const match = str.match(/(\d{3})\/(\d{1,2})\/(\d{1,2})/) || str.match(/(\d{3})(\d{2})(\d{2})/) || str.match(/(\d{3})(\d{1,2})(\d{1,2})/);
            if (match) {
                const rocYear = parseInt(match[1], 10);
                const month = String(parseInt(match[2], 10)).padStart(2, '0');
                const day = String(parseInt(match[3], 10)).padStart(2, '0');
                if (parseInt(month, 10) > 12 || parseInt(month, 10) < 1 || parseInt(day, 10) < 1 || parseInt(day, 10) > 31) return null;
                const year = rocYear + 1911;
                return `${year}-${month}-${day}`;
            }
            return null;
        }

        // 解析金額（處理括號表示的負數）
        function parseAmount(value) {
            if (value === null || value === undefined || value === '') return null;
            const str = getCellText(value);
            let amount = parseFloat(str.replace(/,/g, '').replace(/[()]/g, ''));
            if (isNaN(amount)) return null;
            // 如果原始值包含括號，表示是負數（支出）
            if (str.includes('(') || amount < 0) {
                return Math.abs(amount);
            }
            return amount;
        }

        // 從標題中找到欄位索引
        function findColumnIndex(keywords) {
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i] || '').toLowerCase();
                for (const keyword of keywords) {
                    if (header.includes(keyword.toLowerCase())) {
                        return i;
                    }
                }
            }
            return -1;
        }

        const dateIndex = findColumnIndex(['日期', 'date', '交易日期']);
        const descIndex = findColumnIndex(['說明', '描述', 'description', 'desc', '摘要']);
        const typeIndex = findColumnIndex(['類型', 'type', '收支類型']);
        const categoryIndex = findColumnIndex(['類別', 'category']);
        const companyIndex = findColumnIndex(['公司', 'company', '公司名稱']);
        const accountIndex = findColumnIndex(['帳戶', 'account', '帳戶名稱']);
        const accountNumIndex = findColumnIndex(['帳號', 'account_number', 'accountnumber']);
        const remarksIndex = findColumnIndex(['備註', 'remarks', 'note', 'notes']);

        // 找出金額欄位（可能有多個）
        const amountIndices = [];
        for (let i = 0; i < headers.length; i++) {
            const header = String(headers[i] || '').toLowerCase();
            if (header.includes('金額') || header.includes('amount') || header.match(/^金額\d+$/)) {
                amountIndices.push(i);
            }
        }

        // 處理每一行資料（從第二行開始）
        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            
            // 檢查是否為空行
            let isEmpty = true;
            row.eachCell({ includeEmpty: false }, () => {
                isEmpty = false;
            });
            if (isEmpty) continue;

            try {
                // 讀取日期
                let transactionDate = null;
                if (dateIndex >= 0) {
                    const dateCell = row.getCell(dateIndex + 1);
                    let dateValue = dateCell.value;
                    if (dateValue instanceof Date) {
                        transactionDate = dateValue.toISOString().split('T')[0];
                    } else if (dateValue) {
                        transactionDate = fromROCYear(String(dateValue));
                    }
                }

                if (!transactionDate) {
                    skippedCount++;
                    continue;
                }

                // 讀取說明
                let description = '';
                if (descIndex >= 0) {
                    const descCell = row.getCell(descIndex + 1);
                    description = getCellText(descCell.value);
                }

                // 讀取類型
                let type = 'expense'; // 預設為支出
                if (typeIndex >= 0) {
                    const typeCell = row.getCell(typeIndex + 1);
                    const typeValue = getCellText(typeCell.value);
                    if (typeValue.includes('收入') || typeValue.toLowerCase().includes('income')) {
                        type = 'income';
                    }
                } else {
                    // 如果沒有類型欄位，從金額判斷（負數或括號表示支出）
                    let hasNegativeAmount = false;
                    for (const amtIdx of amountIndices) {
                        const amtCell = row.getCell(amtIdx + 1);
                        const amtValue = amtCell.value;
                        if (amtValue && (String(amtValue).includes('(') || parseFloat(String(amtValue).replace(/,/g, '')) < 0)) {
                            hasNegativeAmount = true;
                            break;
                        }
                    }
                    type = hasNegativeAmount ? 'expense' : 'income';
                }

                // 讀取金額（使用第一個有值的金額欄位）
                let amount = null;
                for (const amtIdx of amountIndices) {
                    const amtCell = row.getCell(amtIdx + 1);
                    const amtValue = parseAmount(amtCell.value);
                    if (amtValue !== null && amtValue !== 0) {
                        amount = amtValue;
                        break;
                    }
                }

                if (!amount || amount === 0) {
                    skippedCount++;
                    continue;
                }

                // 讀取其他欄位（使用 getCellText 避免富文本物件變成 [object Object]）
                const category = categoryIndex >= 0 ? getCellText(row.getCell(categoryIndex + 1).value) : '';
                const companyName = companyIndex >= 0 ? getCellText(row.getCell(companyIndex + 1).value) : '';
                const accountName = accountIndex >= 0 ? getCellText(row.getCell(accountIndex + 1).value) : '';
                const accountNumber = accountNumIndex >= 0 ? getCellText(row.getCell(accountNumIndex + 1).value) : '';
                const remarks = remarksIndex >= 0 ? getCellText(row.getCell(remarksIndex + 1).value) : '';

                // 插入資料庫
                await new Promise((resolve, reject) => {
                    db.run(
                        `INSERT INTO transactions 
                         (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [transactionDate, type, amount, category || null, description || null,
                         companyName || null, accountName || null, accountNumber || null, remarks || null],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        }
                    );
                });

                importedCount++;
            } catch (rowError) {
                errors.push(`第 ${rowNumber} 行: ${rowError.message}`);
            }
        }

        // 刪除上傳的暫存檔案
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: `匯入完成：成功 ${importedCount} 筆，跳過 ${skippedCount} 筆`,
            importedCount,
            skippedCount,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        // 刪除上傳的暫存檔案
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        console.error('匯入錯誤:', error);
        res.status(500).json({ error: '匯入失敗', details: error.message });
    }
});

// ==================== 結算確認 API ====================

// 取得所有結算記錄
app.get('/api/settlements', (req, res) => {
    const { startDate, endDate, company, company_name, account, account_name, account_number, limit = 100, offset = 0, order } = req.query;
    
    let query = 'SELECT * FROM balance_settlements WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND settlement_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND settlement_date <= ?';
        params.push(endDate);
    }
    // 支援 company 和 company_name 兩種參數
    const companyParam = company_name || company;
    if (companyParam) {
        query += ' AND company_name = ?';
        params.push(companyParam);
    }
    // 支援 account 參數（模糊搜尋）
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }
    // 支援精確匹配 account_name
    if (account_name) {
        query += ' AND account_name = ?';
        params.push(account_name);
    }
    // 支援精確匹配 account_number
    if (account_number) {
        query += ' AND account_number = ?';
        params.push(account_number);
    }

    // 排序：支援 order 參數
    if (order === 'date_desc') {
        query += ' ORDER BY settlement_date DESC, id DESC';
    } else {
        query += ' ORDER BY settlement_date DESC, id DESC';
    }
    
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得上一次結算日期
app.get('/api/settlements/last', (req, res) => {
    const { company, account_name, account_number } = req.query;
    
    let query = `
        SELECT * FROM balance_settlements 
        WHERE 1=1
    `;
    const params = [];

    if (company) {
        query += ' AND company_name = ?';
        params.push(company);
    }
    if (account_name) {
        query += ' AND account_name = ?';
        params.push(account_name);
    }
    if (account_number) {
        query += ' AND account_number = ?';
        params.push(account_number);
    }

    query += ' ORDER BY settlement_date DESC LIMIT 1';

    db.get(query, params, (err, row) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: row || null });
    });
});

// 計算結算（從上一次結算到指定日期之間的收支）
app.post('/api/settlements/calculate', (req, res) => {
    const { settlement_date, company_name, account_name, account_number } = req.body;
    
    if (!settlement_date || !company_name) {
        return res.status(400).json({ error: 'settlement_date 和 company_name 為必填欄位' });
    }

    // 先查詢上一次結算記錄
    let lastSettlementQuery = `
        SELECT * FROM balance_settlements 
        WHERE company_name = ?
    `;
    const lastParams = [company_name];
    
    if (account_name) {
        lastSettlementQuery += ' AND account_name = ?';
        lastParams.push(account_name);
    }
    if (account_number) {
        lastSettlementQuery += ' AND account_number = ?';
        lastParams.push(account_number);
    }
    
    lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

    db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
        if (err) {
            console.error('查詢上一次結算錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }

        const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
        const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

        // 計算這段期間的收支
        let transactionQuery = `
            SELECT 
                type,
                SUM(amount) as total
            FROM transactions
            WHERE company_name = ?
            AND transaction_date > ?
            AND transaction_date <= ?
        `;
        const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];
        
        // 帳戶條件：如果有帳戶名稱，優先匹配帳戶名稱；如果有帳號，也匹配帳號
        if (account_name) {
            transactionQuery += ' AND account_name = ?';
            transactionParams.push(account_name);
        } else if (account_number) {
            transactionQuery += ' AND account_number = ?';
            transactionParams.push(account_number);
        }
        
        transactionQuery += ' GROUP BY type';

        db.all(transactionQuery, transactionParams, (err, transactionRows) => {
            if (err) {
                console.error('計算收支錯誤:', err);
                return res.status(500).json({ error: '計算失敗', details: err.message });
            }

            let totalIncome = 0;
            let totalExpense = 0;

            // 確保正確處理每種類型的總額
            if (transactionRows && transactionRows.length > 0) {
                transactionRows.forEach(row => {
                    const total = parseFloat(row.total) || 0;
                    if (row.type === 'income') {
                        totalIncome = total;
                    } else if (row.type === 'expense') {
                        totalExpense = total;
                    }
                });
            }
            
            console.log('結算計算結果:', {
                company_name,
                account_name,
                account_number,
                previousDate,
                settlement_date,
                transactionRows: transactionRows || [],
                totalIncome,
                totalExpense
            });

            const calculatedBalance = openingBalance + totalIncome - totalExpense;

            res.json({
                data: {
                    previous_settlement_date: previousDate,
                    opening_balance: openingBalance,
                    total_income: totalIncome,
                    total_expense: totalExpense,
                    calculated_balance: calculatedBalance,
                    period_start: previousDate || '無',
                    period_end: settlement_date
                }
            });
        });
    });
});

// 新增結算記錄
app.post('/api/settlements', (req, res) => {
    const { 
        settlement_date, 
        company_name, 
        account_name, 
        account_number,
        actual_balance,
        remarks 
    } = req.body;
    
    if (!settlement_date || !company_name || actual_balance === undefined) {
        return res.status(400).json({ error: 'settlement_date、company_name 和 actual_balance 為必填欄位' });
    }

    // 先計算結算數據
    const calculatePromise = new Promise((resolve, reject) => {
        let lastSettlementQuery = `
            SELECT * FROM balance_settlements 
            WHERE company_name = ?
        `;
        const lastParams = [company_name];
        
        if (account_name) {
            lastSettlementQuery += ' AND account_name = ?';
            lastParams.push(account_name);
        }
        if (account_number) {
            lastSettlementQuery += ' AND account_number = ?';
            lastParams.push(account_number);
        }
        
        lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

        db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
            if (err) {
                return reject(err);
            }

            const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
            const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

            let transactionQuery = `
                SELECT 
                    type,
                    SUM(amount) as total
                FROM transactions
                WHERE company_name = ?
                AND transaction_date > ?
                AND transaction_date <= ?
            `;
            const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];
            
            // 帳戶條件：如果提供了帳戶名稱或帳號，則匹配對應的帳戶
            // 注意：當用戶選擇帳戶時，account_name 和 account_number 通常都會被設置
            if (account_name && account_number) {
                // 同時匹配帳戶名稱和帳號（更精確）
                transactionQuery += ' AND account_name = ? AND account_number = ?';
                transactionParams.push(account_name, account_number);
            } else if (account_name) {
                transactionQuery += ' AND account_name = ?';
                transactionParams.push(account_name);
            } else if (account_number) {
                transactionQuery += ' AND account_number = ?';
                transactionParams.push(account_number);
            }
            
            transactionQuery += ' GROUP BY type';

            db.all(transactionQuery, transactionParams, (err, transactionRows) => {
                if (err) {
                    return reject(err);
                }

                let totalIncome = 0;
                let totalExpense = 0;

                // 確保正確處理每種類型的總額
                if (transactionRows && transactionRows.length > 0) {
                    transactionRows.forEach(row => {
                        const total = parseFloat(row.total) || 0;
                        if (row.type === 'income') {
                            totalIncome = total;
                        } else if (row.type === 'expense') {
                            totalExpense = total;
                        }
                    });
                }
                
                console.log('結算計算結果（儲存時）:', {
                    company_name,
                    account_name,
                    account_number,
                    previousDate,
                    settlement_date,
                    transactionRows: transactionRows || [],
                    totalIncome,
                    totalExpense
                });

                const calculatedBalance = openingBalance + totalIncome - totalExpense;
                const actualBal = parseFloat(actual_balance);
                const difference = actualBal - calculatedBalance;

                resolve({
                    previous_settlement_date: previousDate,
                    opening_balance: openingBalance,
                    total_income: totalIncome,
                    total_expense: totalExpense,
                    calculated_balance: calculatedBalance,
                    difference: difference
                });
            });
        });
    });

    calculatePromise.then(calcData => {
        db.run(
            `INSERT INTO balance_settlements 
             (settlement_date, company_name, account_name, account_number, 
              previous_settlement_date, opening_balance, total_income, total_expense, 
              calculated_balance, actual_balance, difference, remarks) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [settlement_date, company_name, account_name || null, account_number || null,
             calcData.previous_settlement_date, calcData.opening_balance, calcData.total_income, 
             calcData.total_expense, calcData.calculated_balance, parseFloat(actual_balance), 
             calcData.difference, remarks || null],
            async function(err) {
                if (err) {
                    console.error('新增結算錯誤:', err);
                    return res.status(500).json({ error: '新增失敗', details: err.message });
                }
                
                const newId = this.lastID;
                const afterData = { id: newId, settlement_date, company_name, account_name: account_name || null, account_number: account_number || null, previous_settlement_date: calcData.previous_settlement_date, opening_balance: calcData.opening_balance, total_income: calcData.total_income, total_expense: calcData.total_expense, calculated_balance: calcData.calculated_balance, actual_balance: parseFloat(actual_balance), difference: calcData.difference, remarks: remarks || null };
                writeOperationLog(req, 'create', 'settlement', newId, null, afterData, '結算 #' + newId + ' ' + (settlement_date || ''));
                try {
                    if (account_name) {
                        await updateBankAccountBalance(account_name, account_number, company_name || null);
                    }
                } catch (error) {
                    console.error('更新帳戶餘額失敗:', error);
                }
                
                res.json({ 
                    success: true, 
                    id: newId,
                    message: '結算記錄已新增',
                    data: { ...calcData, id: newId }
                });
            }
        );
    }).catch(err => {
        console.error('計算結算數據錯誤:', err);
        res.status(500).json({ error: '計算失敗', details: err.message });
    });
});

// 取得單一結算記錄
app.get('/api/settlements/:id', (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        res.json({ data: row });
    });
});

// 更新結算記錄（需要管理員權限）
app.put('/api/settlements/:id', requireAuth, requireAdmin, (req, res) => {
    const { id } = req.params;
    const { 
        settlement_date, 
        company_name, 
        account_name, 
        account_number,
        actual_balance,
        remarks 
    } = req.body;
    
    if (!settlement_date || !company_name || actual_balance === undefined) {
        return res.status(400).json({ error: 'settlement_date、company_name 和 actual_balance 為必填欄位' });
    }
    
    // 先獲取舊的結算記錄（含公司名以正確更新餘額）
    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, oldRow) => {
        if (err) {
            console.error('查詢舊記錄錯誤:', err);
            return res.status(500).json({ error: '更新失敗', details: err.message });
        }
        if (!oldRow) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const oldSettlement = oldRow;
        const oldAccountName = oldSettlement.account_name;
        const oldAccountNumber = oldSettlement.account_number;

    // 先計算結算數據
    const calculatePromise = new Promise((resolve, reject) => {
        let lastSettlementQuery = `
            SELECT * FROM balance_settlements 
            WHERE company_name = ?
            AND id != ?
        `;
        const lastParams = [company_name, id];
        
        if (account_name) {
            lastSettlementQuery += ' AND account_name = ?';
            lastParams.push(account_name);
        }
        if (account_number) {
            lastSettlementQuery += ' AND account_number = ?';
            lastParams.push(account_number);
        }
        
        lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

        db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
            if (err) {
                return reject(err);
            }

            const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
            const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

            let transactionQuery = `
                SELECT 
                    type,
                    SUM(amount) as total
                FROM transactions
                WHERE company_name = ?
                AND transaction_date > ?
                AND transaction_date <= ?
            `;
            const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];
            
            if (account_name && account_number) {
                transactionQuery += ' AND account_name = ? AND account_number = ?';
                transactionParams.push(account_name, account_number);
            } else if (account_name) {
                transactionQuery += ' AND account_name = ?';
                transactionParams.push(account_name);
            } else if (account_number) {
                transactionQuery += ' AND account_number = ?';
                transactionParams.push(account_number);
            }
            
            transactionQuery += ' GROUP BY type';

            db.all(transactionQuery, transactionParams, (err, transactionRows) => {
                if (err) {
                    return reject(err);
                }

                let totalIncome = 0;
                let totalExpense = 0;

                if (transactionRows && transactionRows.length > 0) {
                    transactionRows.forEach(row => {
                        const total = parseFloat(row.total) || 0;
                        if (row.type === 'income') {
                            totalIncome = total;
                        } else if (row.type === 'expense') {
                            totalExpense = total;
                        }
                    });
                }

                const calculatedBalance = openingBalance + totalIncome - totalExpense;
                const actualBal = parseFloat(actual_balance);
                const difference = actualBal - calculatedBalance;

                resolve({
                    previous_settlement_date: previousDate,
                    opening_balance: openingBalance,
                    total_income: totalIncome,
                    total_expense: totalExpense,
                    calculated_balance: calculatedBalance,
                    difference: difference
                });
            });
        });
    });

    calculatePromise.then(calcData => {
        db.run(
            `UPDATE balance_settlements 
             SET settlement_date = ?, company_name = ?, account_name = ?, account_number = ?, 
                 previous_settlement_date = ?, opening_balance = ?, total_income = ?, total_expense = ?, 
                 calculated_balance = ?, actual_balance = ?, difference = ?, remarks = ?, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [settlement_date, company_name, account_name || null, account_number || null,
             calcData.previous_settlement_date, calcData.opening_balance, calcData.total_income, 
             calcData.total_expense, calcData.calculated_balance, parseFloat(actual_balance), 
             calcData.difference, remarks || null, id],
            async function(err) {
                if (err) {
                    console.error('更新結算錯誤:', err);
                    return res.status(500).json({ error: '更新失敗', details: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: '找不到記錄' });
                }
                const afterData = {
                    id: parseInt(id, 10),
                    settlement_date,
                    company_name,
                    account_name: account_name || null,
                    account_number: account_number || null,
                    previous_settlement_date: calcData.previous_settlement_date,
                    opening_balance: calcData.opening_balance,
                    total_income: calcData.total_income,
                    total_expense: calcData.total_expense,
                    calculated_balance: calcData.calculated_balance,
                    actual_balance: parseFloat(actual_balance),
                    difference: calcData.difference,
                    remarks: remarks || null
                };
                writeOperationLog(req, 'update', 'settlement', id, oldRow, afterData, '結算 #' + id + ' ' + (settlement_date || ''));
                try {
                    const oldCompanyName = oldSettlement.company_name;
                    const accountChanged = oldAccountName !== account_name || oldAccountNumber !== account_number;
                    if (accountChanged && oldAccountName) {
                        await updateBankAccountBalance(oldAccountName, oldAccountNumber, oldCompanyName || null);
                    }
                    if (account_name) {
                        await updateBankAccountBalance(account_name, account_number, company_name || null);
                    }
                } catch (error) {
                    console.error('更新帳戶餘額失敗:', error);
                }
                
                res.json({ 
                    success: true, 
                    message: '結算記錄已更新',
                    data: { ...calcData, id: parseInt(id) }
                });
            }
        );
    }).catch(err => {
        console.error('計算結算數據錯誤:', err);
        res.status(500).json({ error: '計算失敗', details: err.message });
    });
    });
});

// 刪除結算記錄
app.delete('/api/settlements/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM balance_settlements WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                console.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'settlement', id, row, null, '結算 #' + id + ' ' + (row.settlement_date || ''));
            res.json({ success: true, message: '記錄已刪除' });
        });
    });
});

// ==================== 系統健康狀態 API（僅管理員）====================

app.get('/api/admin/health', requireAuth, requireAdmin, (req, res) => {
    const startTime = Date.now();
    const health = {
        dbStatus: 'ok',
        uptime: process.uptime ? process.uptime() : 0,
        nodeVersion: process.version || 'N/A',
        environment: process.env.NODE_ENV || 'development',
        transactionCount: 0,
        accountCount: 0,
        companyCount: 0,
        userCount: 0,
        lastTransactionDate: null,
        lastSettlementDate: null,
        responseTimeMs: 0
    };

    db.get('SELECT COUNT(*) as c FROM transactions', [], (err, row) => {
        if (err) {
            health.dbStatus = 'error';
            health.responseTimeMs = Date.now() - startTime;
            return res.json(health);
        }
        health.transactionCount = row ? row.c : 0;

        db.get('SELECT COUNT(*) as c FROM bank_accounts WHERE is_active = 1', [], (err, row) => {
            if (err) {
                health.dbStatus = 'error';
                health.responseTimeMs = Date.now() - startTime;
                return res.json(health);
            }
            health.accountCount = row ? row.c : 0;

            db.get('SELECT COUNT(*) as c FROM companies', [], (err, row) => {
                if (err) {
                    health.dbStatus = 'error';
                    health.responseTimeMs = Date.now() - startTime;
                    return res.json(health);
                }
                health.companyCount = row ? row.c : 0;

                db.get('SELECT COUNT(*) as c FROM users', [], (err, row) => {
                    if (err) {
                        health.dbStatus = 'error';
                        health.responseTimeMs = Date.now() - startTime;
                        return res.json(health);
                    }
                    health.userCount = row ? row.c : 0;

                    db.get('SELECT MAX(transaction_date) as d FROM transactions', [], (err, row) => {
                        if (!err && row && row.d) health.lastTransactionDate = row.d;

                        db.get('SELECT MAX(settlement_date) as d FROM balance_settlements', [], (err, row) => {
                            if (!err && row && row.d) health.lastSettlementDate = row.d;
                            health.responseTimeMs = Date.now() - startTime;
                            res.json(health);
                        });
                    });
                });
            });
        });
    });
});

// 操作日誌 API（僅管理員）- 於 API 內直接建立表，不依賴遷移
app.get('/api/admin/operation-logs', requireAuth, requireAdmin, (req, res) => {
    const { limit = 100, offset = 0, entity_type, action: actionFilter } = req.query;
    const sendError = (msg, err) => {
        console.error(msg, err);
        res.status(500).json({ error: '查詢失敗', details: (err && err.message) || msg });
    };
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            sendError('建立操作日誌表失敗:', createErr);
            return;
        }
        let query = 'SELECT * FROM operation_logs WHERE 1=1';
        const params = [];
        if (entity_type) {
            query += ' AND entity_type = ?';
            params.push(entity_type);
        }
        if (actionFilter) {
            query += ' AND action = ?';
            params.push(actionFilter);
        }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        db.all(query, params, (err, rows) => {
            if (err) {
                sendError('查詢操作日誌錯誤:', err);
                return;
            }
            const data = (rows || []).map(row => {
                let before_data = null, after_data = null;
                try {
                    if (row.before_data) before_data = JSON.parse(row.before_data);
                    if (row.after_data) after_data = JSON.parse(row.after_data);
                } catch (e) { /* 忽略解析錯誤 */ }
                return {
                    id: row.id,
                    created_at: row.created_at,
                    user_id: row.user_id,
                    username: row.username,
                    action: row.action,
                    entity_type: row.entity_type,
                    entity_id: row.entity_id,
                    before_data,
                    after_data,
                    summary: row.summary
                };
            });
            res.json({ data });
        });
    });
});

// ==================== 備份管理 API（僅管理員）====================

// 列出所有備份檔案（優先使用 BACKUP_PATH，其次 DEPLOY_PATH/backups）
app.get('/api/admin/backups', requireAuth, requireAdmin, (req, res) => {
    const deployPath = process.env.DEPLOY_PATH || __dirname;
    const backupPaths = [];
    if (process.env.BACKUP_PATH) {
        backupPaths.push(process.env.BACKUP_PATH);
    }
    const defaultBackups = path.join(deployPath, 'backups');
    if (!backupPaths.includes(defaultBackups)) {
        backupPaths.push(defaultBackups);
    }
    
    const backups = [];
    
    backupPaths.forEach(backupPath => {
        if (!fs.existsSync(backupPath)) {
            return;
        }
        
        const source = backupPath.includes('/opt/') ? 'system' : 'local';
        
        try {
            const files = fs.readdirSync(backupPath);
            files.filter(file => file.endsWith('.db')).forEach(file => {
                const filepath = path.join(backupPath, file);
                try {
                    const stats = fs.statSync(filepath);
                    backups.push({
                        filename: file,
                        filepath: filepath,
                        source: source,
                        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
                        sizeBytes: stats.size,
                        created: stats.mtime
                    });
                } catch (err) {
                    // 忽略無法讀取的檔案
                }
            });
        } catch (err) {
            // 忽略無法讀取的目錄
        }
    });
    
    // 按建立時間排序（最新的在前）
    backups.sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json({ data: backups });
});

// 創建新備份
app.post('/api/admin/backup', requireAuth, requireAdmin, (req, res) => {
    const dbPath = path.join(__dirname, 'database', 'fund_report.db');
    const backupDir = process.env.BACKUP_PATH || path.join(__dirname, 'backups');
    
    if (!fs.existsSync(dbPath)) {
        return res.status(404).json({ error: '找不到資料庫檔案' });
    }
    
    // 確保備份目錄存在
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const backupFile = path.join(backupDir, `fund_report_${timestamp}.db`);
    
    try {
        fs.copyFileSync(dbPath, backupFile);
        const stats = fs.statSync(backupFile);
        
        res.json({ 
            success: true, 
            message: '備份建立成功',
            backup: {
                filename: path.basename(backupFile),
                filepath: backupFile,
                size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
            }
        });
    } catch (error) {
        console.error('備份失敗:', error);
        res.status(500).json({ error: '備份失敗', details: error.message });
    }
});

// 下載備份檔案
app.post('/api/admin/backup/download', requireAuth, requireAdmin, (req, res) => {
    const { filepath } = req.body;
    if (!filepath || typeof filepath !== 'string') {
        return res.status(400).json({ error: '請提供備份檔案路徑' });
    }
    const deployPath = process.env.DEPLOY_PATH || __dirname;
    const backupPaths = [];
    if (process.env.BACKUP_PATH) backupPaths.push(path.resolve(process.env.BACKUP_PATH));
    backupPaths.push(path.resolve(deployPath, 'backups'));
    const resolved = path.resolve(filepath);
    const allowed = backupPaths.some(base => resolved.startsWith(base));
    if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return res.status(404).json({ error: '找不到備份檔案' });
    }
    const filename = path.basename(resolved);
    res.download(resolved, filename, err => {
        if (err) console.error('下載備份失敗:', err);
    });
});

// 還原備份
app.post('/api/admin/restore', requireAuth, requireAdmin, (req, res) => {
    const { filepath } = req.body;
    
    if (!filepath) {
        return res.status(400).json({ error: '請提供備份檔案路徑' });
    }
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: '找不到備份檔案' });
    }
    
    const dbPath = path.join(__dirname, 'database', 'fund_report.db');
    
    // 先備份當前資料庫
    const preRestoreBackup = path.join(
        path.dirname(dbPath), 
        `fund_report_pre_restore_${Date.now()}.db`
    );
    
    try {
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, preRestoreBackup);
        }
        
        // 還原備份
        fs.copyFileSync(filepath, dbPath);
        
        res.json({ 
            success: true, 
            message: '備份還原成功，建議重新啟動伺服器以確保資料正確載入'
        });
    } catch (error) {
        console.error('還原失敗:', error);
        
        // 如果還原失敗，嘗試恢復原資料庫
        if (fs.existsSync(preRestoreBackup)) {
            try {
                fs.copyFileSync(preRestoreBackup, dbPath);
            } catch (restoreError) {
                console.error('恢復原資料庫失敗:', restoreError);
            }
        }
        
        res.status(500).json({ error: '還原失敗', details: error.message });
    }
});

// 啟動伺服器（綁定到所有網路介面，允許外部訪問）
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`${APP_TITLE} 伺服器運行於 http://${HOST}:${PORT}`);
    console.log(`本地訪問: http://localhost:${PORT}`);
    
    // 顯示網路 IP 地址（用於外部訪問）
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳過內部（非 IPv4）和非外部地址（即 127.0.0.1 和 ::1）
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    
    if (addresses.length > 0) {
        console.log(`外部訪問地址:`);
        addresses.forEach(addr => {
            console.log(`  http://${addr}:${PORT}`);
        });
    }
    
    console.log(`API 文檔: http://localhost:${PORT}/api/reports`);
});
