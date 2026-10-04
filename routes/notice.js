// 系統更新通知：管理員發佈一則公告（可附預計更新時間），所有已登入使用者的每個頁面頂端都會顯示橫幅。
// 內容存在 system_settings（key = system_update_notice，value 為 JSON），一次只有一則，撤除就是刪掉那一列。
const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');
const { writeOperationLog } = require('../utils/operationLog');

const NOTICE_KEY = 'system_update_notice';
const MAX_MESSAGE_LENGTH = 500;
const AFTER_SCHEDULE_GRACE_MS = 60 * 60 * 1000;   // 預計更新時間過後 1 小時自動不再顯示
const NO_SCHEDULE_TTL_MS = 24 * 60 * 60 * 1000;   // 沒填更新時間的通知，發佈 24 小時後自動不再顯示
const SCHEDULED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/; // datetime-local 格式，視為台北時間

function parseStored(row) {
    if (!row || !row.value) return null;
    try {
        return JSON.parse(row.value);
    } catch (e) {
        return null;
    }
}

// 通知是否已過期（過期的視同沒有通知）
function isExpired(notice, nowMs = Date.now()) {
    if (notice.scheduled_at) {
        const t = Date.parse(`${notice.scheduled_at}:00+08:00`);
        if (Number.isFinite(t)) return nowMs > t + AFTER_SCHEDULE_GRACE_MS;
    }
    const created = Date.parse(notice.created_at);
    return Number.isFinite(created) && nowMs > created + NO_SCHEDULE_TTL_MS;
}

// 所有已登入使用者：目前有效的通知（沒有就回 null）
router.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    db.get('SELECT value FROM system_settings WHERE key = ?', [NOTICE_KEY], (err, row) => {
        if (err) {
            logger.error('查詢系統通知錯誤:', err);
            return res.status(500).json({ error: '查詢失敗' });
        }
        const notice = parseStored(row);
        res.json({ notice: notice && !isExpired(notice) ? notice : null });
    });
});

// 管理員：發佈（或覆蓋）通知。message 與 scheduled_at 至少填一項
router.put('/', requireAdmin, (req, res) => {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const scheduledAt = req.body.scheduled_at ? String(req.body.scheduled_at).trim() : '';
    if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `通知內容不可超過 ${MAX_MESSAGE_LENGTH} 字` });
    }
    if (scheduledAt && (!SCHEDULED_AT_PATTERN.test(scheduledAt) || !Number.isFinite(Date.parse(`${scheduledAt}:00+08:00`)))) {
        return res.status(400).json({ error: '預計更新時間格式不正確' });
    }
    if (!message && !scheduledAt) {
        return res.status(400).json({ error: '請至少填寫通知內容或預計更新時間' });
    }
    db.get('SELECT value FROM system_settings WHERE key = ?', [NOTICE_KEY], (getErr, oldRow) => {
        if (getErr) {
            logger.error('查詢系統通知錯誤:', getErr);
            return res.status(500).json({ error: '儲存失敗' });
        }
        const now = new Date().toISOString();
        const notice = {
            message,
            scheduled_at: scheduledAt || null,
            created_at: now,
            created_by: req.session.username || null
        };
        db.run(
            `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [NOTICE_KEY, JSON.stringify(notice), now],
            (err) => {
                if (err) {
                    logger.error('儲存系統通知錯誤:', err);
                    return res.status(500).json({ error: '儲存失敗' });
                }
                writeOperationLog(req, 'update', 'system_settings', NOTICE_KEY, parseStored(oldRow), notice, '發佈系統更新通知');
                res.json({ success: true, notice });
            }
        );
    });
});

// 管理員：撤除通知
router.delete('/', requireAdmin, (req, res) => {
    db.get('SELECT value FROM system_settings WHERE key = ?', [NOTICE_KEY], (getErr, oldRow) => {
        if (getErr) {
            logger.error('查詢系統通知錯誤:', getErr);
            return res.status(500).json({ error: '撤除失敗' });
        }
        db.run('DELETE FROM system_settings WHERE key = ?', [NOTICE_KEY], (err) => {
            if (err) {
                logger.error('撤除系統通知錯誤:', err);
                return res.status(500).json({ error: '撤除失敗' });
            }
            if (oldRow) writeOperationLog(req, 'update', 'system_settings', NOTICE_KEY, parseStored(oldRow), null, '撤除系統更新通知');
            res.json({ success: true });
        });
    });
});

module.exports = router;
