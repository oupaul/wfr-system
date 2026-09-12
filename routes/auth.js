const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { db } = require('../database/db');
const logger = require('../utils/logger');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '登入嘗試次數過多，請 15 分鐘後再試' },
    skipSuccessfulRequests: true
});

// 檢查認證狀態
router.get('/check', (req, res) => {
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
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password, rememberMe } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '請輸入使用者名稱和密碼' });
    }

    db.get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username], async (err, user) => {
        if (err) {
            logger.error('登入查詢錯誤:', err);
            return res.status(500).json({ error: '登入失敗' });
        }

        if (!user) {
            logger.warn(`登入失敗（帳號不存在）: ${username} from ${req.ip}`);
            return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
        }

        try {
            const valid = await argon2.verify(user.password_hash, password);

            if (!valid) {
                logger.warn(`登入失敗（密碼錯誤）: ${username} from ${req.ip}`);
                return res.status(401).json({ error: '使用者名稱或密碼錯誤' });
            }

            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;

            if (rememberMe) {
                req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000;
            }

            req.session.save((saveErr) => {
                if (saveErr) {
                    logger.error('Session 保存錯誤:', saveErr);
                    return res.status(500).json({ error: '登入失敗' });
                }

                db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id], (updateErr) => {
                    if (updateErr) {
                        logger.error('更新 last_login 失敗:', updateErr);
                    }
                });
                logger.info(`登入成功: ${username} from ${req.ip}`);

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
            logger.error('密碼驗證錯誤:', error);
            return res.status(500).json({ error: '登入失敗' });
        }
    });
});

// 登出
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            logger.error('登出錯誤:', err);
            return res.status(500).json({ error: '登出失敗' });
        }
        res.json({ success: true, message: '已登出' });
    });
});

module.exports = router;
