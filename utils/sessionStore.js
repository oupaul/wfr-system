const path = require('path');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const logger = require('./logger');

const SQLiteStore = SQLiteStoreFactory(session);

// 全站共用同一個 session store 實例：server.js 掛給 express-session 使用，
// routes/users.js 在停用／降權／刪除使用者時，也需要透過同一個實例撤銷該使用者的現有 session。
const sessionStore = new SQLiteStore({
    db: 'sessions.db',
    dir: path.join(__dirname, '..', 'database'),
    table: 'sessions',
    cleanupInterval: 60 * 60 * 1000 // 每小時清理過期 session
});

/**
 * 立即撤銷某使用者目前所有的登入 session。
 *
 * requireAuth/requireAdmin/requireEditor 只檢查 session 裡快取的 userId/role，
 * 不會每次請求都重新查資料庫；若人員管理把某人停用、降權或刪除後不清掉他既有的
 * session，該使用者仍可用舊 session 繼續呼叫 API，直到 session 自然過期為止
 * （閒置 30 分鐘，或勾選「記住我」時長達 7 天）。此函式讓權限變更立即生效。
 */
function revokeSessionsForUser(userId) {
    if (!userId) return;
    sessionStore.db.all(`SELECT sid, sess FROM sessions`, [], (err, rows) => {
        if (err) {
            logger.error('[Session] 查詢 session 以撤銷權限失敗:', err.message);
            return;
        }
        (rows || []).forEach(row => {
            let sess;
            try {
                sess = JSON.parse(row.sess);
            } catch (e) {
                return; // 忽略無法解析的 session 資料
            }
            if (sess && sess.userId === userId) {
                sessionStore.destroy(row.sid, (destroyErr) => {
                    if (destroyErr) logger.error('[Session] 撤銷 session 失敗:', destroyErr.message);
                });
            }
        });
    });
}

module.exports = { sessionStore, revokeSessionsForUser };
