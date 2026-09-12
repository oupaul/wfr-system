const express = require('express');
const router = express.Router();
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { isConfigured: ssoConfigured, verifyEntraIdToken } = require('../utils/entraAuth');

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

// 建立登入 session（本機帳密登入、M365 SSO 登入共用）
function establishSession(req, res, user, { rememberMe = false, logSource = '' } = {}) {
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
        logger.info(`登入成功${logSource}: ${user.username} from ${req.ip}`);

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
}

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

            establishSession(req, res, user, { rememberMe });
        } catch (error) {
            logger.error('密碼驗證錯誤:', error);
            return res.status(500).json({ error: '登入失敗' });
        }
    });
});

// M365 / Entra ID SSO 登入
// 前端用 MSAL.js 走完 Authorization Code + PKCE 流程後，把拿到的 ID token 送來這裡驗證。
// 僅允許 email 已存在於 users 表且啟用中的帳號登入，不會自動建立新帳號。
router.post('/sso-login', loginLimiter, async (req, res) => {
    if (!ssoConfigured()) {
        return res.status(503).json({ error: '尚未啟用 M365 登入' });
    }

    const { idToken } = req.body;
    if (!idToken) {
        return res.status(400).json({ error: '缺少 idToken' });
    }

    let email;
    try {
        const result = await verifyEntraIdToken(idToken);
        email = result.email;
    } catch (error) {
        logger.warn(`M365 SSO token 驗證失敗 from ${req.ip}: ${error.message}`);
        return res.status(401).json({ error: 'M365 登入驗證失敗' });
    }

    if (!email) {
        return res.status(401).json({ error: '無法從 M365 帳號取得電子郵件' });
    }

    db.get('SELECT * FROM users WHERE LOWER(email) = ? AND is_active = 1', [email], (err, user) => {
        if (err) {
            logger.error('SSO 登入查詢錯誤:', err);
            return res.status(500).json({ error: '登入失敗' });
        }

        if (!user) {
            logger.warn(`M365 SSO 登入被拒（找不到對應帳號）: ${email} from ${req.ip}`);
            return res.status(403).json({ error: '此 M365 帳號尚未被授權使用本系統，請聯絡管理員新增帳號' });
        }

        establishSession(req, res, user, { logSource: '（M365 SSO）' });
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
