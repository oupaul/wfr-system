// 「統計報表」開放給哪些角色：存在 system_settings（key = reports_access），由管理員在報表頁切換。
//   admin   僅管理員（預設，最保守）
//   finance 管理員 + 財務人員
//   all     所有登入的人員
// 沒有這個設定時用 admin：報表有借款、利息等較敏感的資訊，要由管理員主動開放。
const { db } = require('../database/db');

const REPORTS_ACCESS_KEY = 'reports_access';
const ACCESS_LEVELS = ['admin', 'finance', 'all'];
const DEFAULT_ACCESS = 'admin';

function getReportsAccess() {
    return new Promise((resolve) => {
        db.get('SELECT value FROM system_settings WHERE key = ?', [REPORTS_ACCESS_KEY], (err, row) => {
            const v = !err && row ? row.value : DEFAULT_ACCESS;
            resolve(ACCESS_LEVELS.includes(v) ? v : DEFAULT_ACCESS);
        });
    });
}

function setReportsAccess(value) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [REPORTS_ACCESS_KEY, value, now],
            (err) => (err ? reject(err) : resolve())
        );
    });
}

function canViewReports(role, access) {
    if (role === 'admin') return true; // 管理員永遠看得到（也才能調整開放範圍）
    if (access === 'all') return true;
    if (access === 'finance') return role === 'finance';
    return false;
}

module.exports = { ACCESS_LEVELS, DEFAULT_ACCESS, getReportsAccess, setReportsAccess, canViewReports };
