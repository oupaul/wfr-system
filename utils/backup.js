const fs = require('fs');
const path = require('path');
const { db } = require('../database/db');
const logger = require('./logger');

// 檔名格式：fund_report_2026-09-29_10-31-03.db（UTC 時間）。
// 這裡的 `.*` 尾巴容許比對到舊版本遺留的檔名（曾經有個小 bug 讓檔名多帶了
// 毫秒+Z，例如 fund_report_2026-09-29_10-31-03-469Z.db），確保清理舊備份
// 時仍然認得出那些既有檔案，不會因為格式微調就被當成「不是備份檔」而跳過。
const BACKUP_FILENAME_PATTERN = /^fund_report_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*\.db$/;
const PRE_RESTORE_PATTERN = /pre_restore/;

function getBackupDir() {
    return process.env.BACKUP_PATH || path.join(__dirname, '..', 'backups');
}

// 建立一份資料庫備份；VACUUM INTO 不支援時 fallback 成 WAL checkpoint + 檔案複製
// manual 的「立即備份」按鈕跟排程備份都呼叫這一支，避免兩邊邏輯分岔
function createBackup() {
    return new Promise((resolve, reject) => {
        const backupDir = getBackupDir();
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().split('.')[0].replace('T', '_').replace(/:/g, '-');
        const backupFile = path.join(backupDir, `fund_report_${timestamp}.db`);

        db.run('VACUUM INTO ?', [backupFile], (err) => {
            if (err) {
                logger.warn('VACUUM INTO 不支援，改用 WAL checkpoint 備份:', err.message);
                db.run('PRAGMA wal_checkpoint(FULL)', [], (cpErr) => {
                    if (cpErr) logger.warn('WAL checkpoint 警告:', cpErr.message);
                    try {
                        fs.copyFileSync(path.join(__dirname, '..', 'database', 'fund_report.db'), backupFile);
                        const stats = fs.statSync(backupFile);
                        logger.info(`備份建立成功（fallback）: ${backupFile}`);
                        resolve({
                            filename: path.basename(backupFile),
                            filepath: backupFile,
                            size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
                        });
                    } catch (copyErr) {
                        reject(copyErr);
                    }
                });
                return;
            }

            try {
                const stats = fs.statSync(backupFile);
                logger.info(`備份建立成功（VACUUM INTO）: ${backupFile}`);
                resolve({
                    filename: path.basename(backupFile),
                    filepath: backupFile,
                    size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
                });
            } catch (statErr) {
                reject(statErr);
            }
        });
    });
}

// 只清理排程備份自己建立的檔案（檔名嚴格比對），保留最新 keepCount 份、其餘刪除
// 只在排程自動備份成功後呼叫，手動「立即備份」不觸發清理
function pruneOldBackups(backupDir, keepCount) {
    if (!fs.existsSync(backupDir)) return { deleted: 0 };

    const files = fs.readdirSync(backupDir)
        .filter(name => BACKUP_FILENAME_PATTERN.test(name) && !PRE_RESTORE_PATTERN.test(name))
        .map(name => {
            const filepath = path.join(backupDir, name);
            return { name, filepath, mtime: fs.statSync(filepath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime);

    const toDelete = files.slice(keepCount);
    toDelete.forEach(f => {
        try {
            fs.unlinkSync(f.filepath);
        } catch (err) {
            logger.warn(`清理舊備份失敗: ${f.filepath}`, err.message);
        }
    });

    if (toDelete.length > 0) {
        logger.info(`已清理舊備份，保留最新 ${keepCount} 份，刪除 ${toDelete.length} 份`);
    }

    return { deleted: toDelete.length };
}

module.exports = { createBackup, pruneOldBackups, getBackupDir };
