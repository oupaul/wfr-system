const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const logger = require('./utils/logger');
const { db, initDatabase } = require('./database/db');
const { OPERATION_LOGS_TABLE_SQL } = require('./utils/operationLog');
const { requireAuth } = require('./middleware/auth');
const { isConfigured: ssoConfigured, tenantId: entraTenantId, clientId: entraClientId } = require('./utils/entraAuth');

// 載入環境變數（如果存在 .env 檔案）
if (fs.existsSync('.env')) {
    require('dotenv').config();
}

const app = express();
// 部署在反向代理（nginx/Cloudflare）後方時，讓 Express 信任第一層代理的
// X-Forwarded-* 標頭，否則 express-rate-limit 無法正確辨識來源 IP。
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const APP_TITLE = process.env.APP_TITLE || '資金週報系統';
// 收入功能已重新開啟：固定為完整功能（收入 + 支出）。若需改回僅支出，改回下一行並設環境變數 TRANSACTION_MODE=expense_only
const TRANSACTION_MODE = 'full'; // 原: process.env.TRANSACTION_MODE || 'full'
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT) || 30 * 60 * 1000; // 預設 30 分鐘

// ==================== Session 持久化設定 ====================
const SQLiteStore = require('connect-sqlite3')(session);
const sessionStore = new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, 'database'),
    table: 'sessions',
    cleanupInterval: 60 * 60 * 1000 // 每小時清理過期 session
});

// Session 配置
app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'fund-weekly-report-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    name: 'fund-weekly-report.sid',
    cookie: {
        secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
        httpOnly: true,
        maxAge: SESSION_TIMEOUT,
        sameSite: 'lax'
    },
    rolling: true
}));

// ==================== CORS 設定 ====================
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : null;

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!allowedOrigins) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS 不允許的來源: ${origin}`));
    },
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ==================== 路由載入 ====================
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const companyRoutes = require('./routes/companies');
const bankAccountRoutes = require('./routes/bankAccounts');
const transactionRoutes = require('./routes/transactions');
const settlementRoutes = require('./routes/settlements');
const cashGapRoutes = require('./routes/cashGap');
const adminRoutes = require('./routes/admin');

// 提供應用標題的 API（無需認證）
app.get('/api/config', (req, res) => {
    res.json({
        title: APP_TITLE,
        transaction_mode: TRANSACTION_MODE,
        sso: ssoConfigured()
            ? { enabled: true, tenantId: entraTenantId(), clientId: entraClientId() }
            : { enabled: false }
    });
});

// ==================== 保護所有 API 路由（除了認證相關） ====================
// 所有 /api/* 路由都需要認證，除了 /api/auth/* 和 /api/config
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/config') {
        return next();
    }
    return requireAuth(req, res, next);
});

// ==================== API 路由掛載 ====================
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/bank-accounts', bankAccountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api', cashGapRoutes);         // /api/cash-gap-*, /api/import-logs
app.use('/api/admin', adminRoutes);

// ==================== 靜態 HTML 路由 ====================
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

// ==================== 初始化資料庫 ====================
function ensureOperationLogsAndWriteStartupLog() {
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            logger.error('[操作日誌] 啟動時確保表失敗:', createErr.message);
            return;
        }
        db.run(
            `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [null, 'system', 'create', 'system', null, null, null, '系統啟動'],
            function(insertErr) {
                if (insertErr) {
                    const isFk = /foreign key|FOREIGN KEY/i.test(insertErr.message);
                    if (isFk) {
                        logger.warn('[操作日誌] 啟動寫入失敗（疑似舊表含 FOREIGN KEY），嘗試重建表…');
                        db.run('DROP TABLE IF EXISTS operation_logs', [], function(dropErr) {
                            if (dropErr) {
                                logger.error('[操作日誌] 重建表失敗:', dropErr.message);
                                return;
                            }
                            db.run(OPERATION_LOGS_TABLE_SQL, [], function(create2Err) {
                                if (create2Err) {
                                    logger.error('[操作日誌] 重建表失敗:', create2Err.message);
                                    return;
                                }
                                db.run(
                                    `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                    [null, 'system', 'create', 'system', null, null, null, '系統啟動'],
                                    function(insert2Err) {
                                        if (insert2Err) logger.error('[操作日誌] 重建後寫入仍失敗:', insert2Err.message);
                                        else logger.info('[操作日誌] 表已重建，啟動日誌已寫入');
                                    }
                                );
                            });
                        });
                    } else {
                        logger.error('[操作日誌] 啟動測試寫入失敗:', insertErr.message);
                    }
                } else {
                    logger.info('[操作日誌] 表已就緒，啟動日誌已寫入');
                }
            }
        );
    });
}
initDatabase().then(() => ensureOperationLogsAndWriteStartupLog()).catch(console.error);

// ==================== 全域錯誤處理中間件 ====================
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: '檔案大小超過限制（最大 10MB）' });
    }
    if (err.message && err.message.startsWith('只允許上傳')) {
        return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.startsWith('CORS')) {
        return res.status(403).json({ error: err.message });
    }
    logger.error('未預期的伺服器錯誤:', err);
    res.status(500).json({ error: '伺服器內部錯誤' });
});

// ==================== 啟動伺服器 ====================
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
    logger.info(`${APP_TITLE} 伺服器運行於 http://${HOST}:${PORT}`);
    logger.info(`本地訪問: http://localhost:${PORT}`);

    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                logger.info(`外部訪問: http://${iface.address}:${PORT}`);
            }
        }
    }
});
