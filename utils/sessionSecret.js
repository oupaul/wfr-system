const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const SECRET_FILE = path.join(__dirname, '..', 'database', '.session-secret');

/**
 * 取得 session 簽章用的密鑰。
 *
 * 優先使用 .env 的 SESSION_SECRET；若沒設定，過去會退回一個寫死在原始碼裡的
 * 字串（且此專案是公開 repo，等於全世界都看得到這把「密鑰」）。現在改為：
 * 首次啟動時隨機產生一把，寫入 database/.session-secret（不會被 git 追蹤）
 * 供之後重啟沿用；讀寫都失敗時才退回同一次執行期間隨機產生的密鑰，此情況
 * 下每次重啟都會換一把，所有使用者會被登出，需要重新登入。
 */
function getSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

    try {
        if (fs.existsSync(SECRET_FILE)) {
            const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (existing) return existing;
        }
    } catch (e) {
        logger.warn('[Session] 讀取既有 session 密鑰失敗，將重新產生:', e.message);
    }

    const generated = crypto.randomBytes(48).toString('hex');
    try {
        fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
        fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
        logger.info('[Session] 已產生新的 session 密鑰並儲存於 database/.session-secret');
    } catch (e) {
        logger.warn('[Session] 無法儲存 session 密鑰，本次執行期間將使用臨時密鑰（重啟後所有人需重新登入）:', e.message);
    }
    return generated;
}

module.exports = { getSessionSecret };
