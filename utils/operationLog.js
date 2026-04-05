const { db } = require('../database/db');
const logger = require('./logger');

const OPERATION_LOGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete')),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_data TEXT,
    after_data TEXT,
    summary TEXT
)`;

function safeJsonStringify(obj) {
    if (obj == null) return null;
    try {
        return JSON.stringify(obj);
    } catch (e) {
        return null;
    }
}

function writeOperationLog(req, action, entityType, entityId, beforeData, afterData, summary) {
    const userId = req && req.session && req.session.userId ? req.session.userId : null;
    const username = (req && req.session && req.session.username) ? req.session.username : 'system';
    const beforeStr = safeJsonStringify(beforeData);
    const afterStr = safeJsonStringify(afterData);
    const entityIdStr = entityId != null ? String(entityId) : null;
    const params = [userId, username, action, entityType, entityIdStr, beforeStr, afterStr, summary || null];
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            logger.error('[操作日誌] 確保操作日誌表失敗:', createErr.message);
            return;
        }
        db.run(
            `INSERT INTO operation_logs (user_id, username, action, entity_type, entity_id, before_data, after_data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params,
            function(insertErr) {
                if (insertErr) {
                    logger.error('[操作日誌] 寫入失敗:', insertErr.message, '| entity_type=', entityType, 'entity_id=', entityIdStr, 'action=', action);
                }
            }
        );
    });
}

module.exports = { OPERATION_LOGS_TABLE_SQL, safeJsonStringify, writeOperationLog };
