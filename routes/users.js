const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { requireAdmin } = require('../middleware/auth');

// 人員管理（含設定角色）僅限管理員，server.js 的全域 gate 只檢查有沒有登入，
// 沒有另外檢查角色，這裡的 requireAdmin 補上才是真正擋住一般使用者的地方。
router.use(requireAdmin);

// 取得所有使用者
router.get('/', (req, res) => {
    db.all('SELECT id, username, full_name, email, role, is_active, last_login, created_at, updated_at FROM users ORDER BY created_at DESC',
        [],
        (err, rows) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows });
        }
    );
});

// 取得單一使用者
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT id, username, full_name, email, role, is_active, last_login, created_at, updated_at FROM users WHERE id = ?',
        [id],
        (err, row) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到使用者' });
            }
            res.json({ data: row });
        }
    );
});

// 新增使用者
router.post('/', async (req, res) => {
    const { username, password, full_name, email, role = 'user', is_active = 1 } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '使用者名稱和密碼為必填欄位' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: '密碼至少需要 6 個字元' });
    }

    db.get('SELECT id FROM users WHERE username = ?', [username], async (err, existingUser) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '新增失敗', details: err.message });
        }

        if (existingUser) {
            return res.status(400).json({ error: '使用者名稱已存在' });
        }

        try {
            const passwordHash = await argon2.hash(password, {
                type: argon2.argon2id,
                memoryCost: 65536,
                timeCost: 3,
                parallelism: 4
            });

            db.run(
                `INSERT INTO users (username, password_hash, full_name, email, role, is_active) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [username, passwordHash, full_name || null, email || null, role, is_active],
                function(err) {
                    if (err) {
                        logger.error('新增錯誤:', err);
                        return res.status(500).json({ error: '新增失敗', details: err.message });
                    }
                    const newId = this.lastID;
                    const afterData = { id: newId, username, full_name: full_name || null, email: email || null, role, is_active };
                    writeOperationLog(req, 'create', 'user', newId, null, afterData, '使用者 #' + newId + ' ' + (username || ''));
                    res.json({ success: true, id: newId, message: '使用者已新增' });
                }
            );
        } catch (error) {
            logger.error('密碼加密錯誤:', error);
            return res.status(500).json({ error: '新增失敗', details: error.message });
        }
    });
});

// 更新使用者
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { username, password, full_name, email, role, is_active } = req.body;

    db.get('SELECT id, username, full_name, email, role, is_active FROM users WHERE id = ?', [id], async (err, oldRow) => {
        if (err) {
            logger.error('查詢錯誤:', err);
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
                    logger.error('查詢錯誤:', err);
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
                        logger.error('更新錯誤:', updateErr);
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
                logger.error('更新錯誤:', error);
                return res.status(500).json({ error: '更新失敗', details: error.message });
            }
        }
    });
});

// 刪除使用者
router.delete('/:id', (req, res) => {
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
                logger.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到使用者' });
            writeOperationLog(req, 'delete', 'user', id, row, null, '使用者 #' + id + ' ' + (row.username || ''));
            res.json({ success: true, message: '使用者已刪除' });
        });
    });
});

module.exports = router;
