const { db } = require('../database/db');
const logger = require('./logger');
const { createBackup, pruneOldBackups, getBackupDir } = require('./backup');

const SETTINGS_KEYS = {
    enabled: 'backup_schedule_enabled',
    hour: 'backup_schedule_hour',
    minute: 'backup_schedule_minute',
    retentionCount: 'backup_schedule_retention',
    lastRunDate: 'backup_schedule_last_run_date',
    lastError: 'backup_schedule_last_error'
};

let enabled = false;
let hour = 2;
let minute = 0;
let retentionCount = 30;
let lastRunDate = null; // 'YYYY-MM-DD'（台北當地日期），避免同一天重複跑
let lastError = null;

let intervalHandle = null;

function taipeiNow() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    }).formatToParts(new Date());
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return {
        date: `${map.year}-${map.month}-${map.day}`,
        hour: parseInt(map.hour, 10),
        minute: parseInt(map.minute, 10)
    };
}

function init() {
    return new Promise((resolve) => {
        db.all(
            `SELECT key, value FROM system_settings WHERE key IN (?, ?, ?, ?, ?, ?)`,
            Object.values(SETTINGS_KEYS),
            (err, rows) => {
                if (!err && rows) {
                    rows.forEach((r) => {
                        if (r.key === SETTINGS_KEYS.enabled) enabled = r.value === 'true';
                        if (r.key === SETTINGS_KEYS.hour) hour = parseInt(r.value, 10);
                        if (r.key === SETTINGS_KEYS.minute) minute = parseInt(r.value, 10);
                        if (r.key === SETTINGS_KEYS.retentionCount) retentionCount = parseInt(r.value, 10);
                        if (r.key === SETTINGS_KEYS.lastRunDate) lastRunDate = r.value || null;
                        if (r.key === SETTINGS_KEYS.lastError) lastError = r.value || null;
                    });
                }
                if (!intervalHandle) {
                    intervalHandle = setInterval(checkAndRun, 60 * 1000);
                }
                logger.info(`備份排程已啟動（${enabled ? '啟用' : '停用'}，每日 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}，保留 ${retentionCount} 份）`);
                resolve();
            }
        );
    });
}

function persistSetting(key, value) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [key, value, now],
            (err) => (err ? reject(err) : resolve())
        );
    });
}

// 管理者在後台儲存設定：立即更新資料庫與記憶體快取，不需要重啟服務
async function saveSettings({ enabled: newEnabled, hour: newHour, minute: newMinute, retentionCount: newRetentionCount }) {
    await persistSetting(SETTINGS_KEYS.enabled, newEnabled ? 'true' : 'false');
    await persistSetting(SETTINGS_KEYS.hour, String(newHour));
    await persistSetting(SETTINGS_KEYS.minute, String(newMinute));
    await persistSetting(SETTINGS_KEYS.retentionCount, String(newRetentionCount));

    enabled = newEnabled;
    hour = newHour;
    minute = newMinute;
    retentionCount = newRetentionCount;
}

function getSettings() {
    return { enabled, hour, minute, retentionCount, lastRunDate, lastError };
}

async function checkAndRun() {
    if (!enabled) return;

    const now = taipeiNow();
    const scheduledMinutesOfDay = hour * 60 + minute;
    const nowMinutesOfDay = now.hour * 60 + now.minute;

    if (nowMinutesOfDay < scheduledMinutesOfDay) return;
    if (lastRunDate === now.date) return;

    try {
        await createBackup();
        pruneOldBackups(getBackupDir(), retentionCount);
        lastRunDate = now.date;
        lastError = null;
        await persistSetting(SETTINGS_KEYS.lastRunDate, lastRunDate);
        await persistSetting(SETTINGS_KEYS.lastError, '');
        logger.info(`排程自動備份成功: ${now.date}`);
    } catch (err) {
        lastError = err.message || String(err);
        await persistSetting(SETTINGS_KEYS.lastError, lastError).catch(() => {});
        logger.error('排程自動備份失敗:', err);
    }
}

module.exports = { init, saveSettings, getSettings };
