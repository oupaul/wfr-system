const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const logger = require('./utils/logger');
const { db, initDatabase } = require('./database/db');
const { OPERATION_LOGS_TABLE_SQL } = require('./utils/operationLog');
const { requireAuth } = require('./middleware/auth');
const entraAuth = require('./utils/entraAuth');
const { isConfigured: ssoConfigured, tenantId: entraTenantId, clientId: entraClientId } = entraAuth;

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

// ==================== 安全性標頭 ====================
// 前端目前是傳統多頁 + 內嵌 <script> 架構（沒有導入建置流程與 CSP nonce），
// 所以 script-src/style-src 仍允許 'unsafe-inline'；主要防護是擋掉點擊劫持
// （frame-ancestors）、限制可連線/可嵌入的來源、以及 helmet 其餘的預設標頭
// （X-Content-Type-Options、隱藏 X-Powered-By 等）。
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
            // 前端大量使用 onclick="..." 等內嵌事件屬性（非 <script> 標籤本身），
            // CSP3 的 script-src-attr 是獨立於 script-src 的指令，helmet 預設為
            // 'none'，若不明確覆寫會把全站的按鈕點擊都擋掉。
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameSrc: ['https://login.microsoftonline.com'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// ==================== Session 持久化設定 ====================
const { sessionStore } = require('./utils/sessionStore');
const { getSessionSecret } = require('./utils/sessionSecret');

// Session 配置
app.use(session({
    store: sessionStore,
    secret: getSessionSecret(),
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
// 前端與 API 都是由同一個伺服器提供，一般情況下完全不需要跨來源存取。
// 只有在 ALLOWED_ORIGINS 明確設定時才放行清單內的來源；未設定時預設拒絕
// 所有「真正跨來源」的請求。注意：瀏覽器對同來源的非 GET 請求（例如登入用的
// POST）也會帶 Origin 標頭，所以不能只看「有沒有 Origin」，必須拿它與當前
// 請求實際的 host 比對，否則會誤擋掉自己網站的請求。
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : [];

app.use(cors((req, callback) => {
    const origin = req.header('Origin');
    const selfOrigin = `${req.protocol}://${req.get('host')}`;
    const allow = !origin || origin === selfOrigin || allowedOrigins.includes(origin);
    callback(null, { origin: allow, credentials: true });
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
initDatabase().then(() => {
    ensureOperationLogsAndWriteStartupLog();
    return entraAuth.init();
}).catch(console.error);

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
