const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { OPERATION_LOGS_TABLE_SQL, writeOperationLog } = require('../utils/operationLog');
const {
    isConfigured: ssoConfigured,
    tenantId: entraTenantId,
    clientId: entraClientId,
    saveSettings: saveSsoSettings,
    isOverriddenInDb,
    envHasValue
} = require('../utils/entraAuth');
const { createBackup } = require('../utils/backup');
const backupScheduler = require('../utils/backupScheduler');

// 系統健康狀態
router.get('/health', requireAuth, requireAdmin, (req, res) => {
    const startTime = Date.now();
    const health = {
        dbStatus: 'ok',
        uptime: process.uptime ? process.uptime() : 0,
        nodeVersion: process.version || 'N/A',
        environment: process.env.NODE_ENV || 'development',
        transactionCount: 0,
        accountCount: 0,
        companyCount: 0,
        userCount: 0,
        lastTransactionDate: null,
        lastSettlementDate: null,
        responseTimeMs: 0
    };

    db.get('SELECT COUNT(*) as c FROM transactions', [], (err, row) => {
        if (err) {
            health.dbStatus = 'error';
            health.responseTimeMs = Date.now() - startTime;
            return res.json(health);
        }
        health.transactionCount = row ? row.c : 0;

        db.get('SELECT COUNT(*) as c FROM bank_accounts WHERE is_active = 1', [], (err, row) => {
            if (err) {
                health.dbStatus = 'error';
                health.responseTimeMs = Date.now() - startTime;
                return res.json(health);
            }
            health.accountCount = row ? row.c : 0;

            db.get('SELECT COUNT(*) as c FROM companies', [], (err, row) => {
                if (err) {
                    health.dbStatus = 'error';
                    health.responseTimeMs = Date.now() - startTime;
                    return res.json(health);
                }
                health.companyCount = row ? row.c : 0;

                db.get('SELECT COUNT(*) as c FROM users', [], (err, row) => {
                    if (err) {
                        health.dbStatus = 'error';
                        health.responseTimeMs = Date.now() - startTime;
                        return res.json(health);
                    }
                    health.userCount = row ? row.c : 0;

                    db.get('SELECT MAX(transaction_date) as d FROM transactions', [], (err, row) => {
                        if (!err && row && row.d) health.lastTransactionDate = row.d;

                        db.get('SELECT MAX(settlement_date) as d FROM balance_settlements', [], (err, row) => {
                            if (!err && row && row.d) health.lastSettlementDate = row.d;
                            health.responseTimeMs = Date.now() - startTime;
                            res.json(health);
                        });
                    });
                });
            });
        });
    });
});

// 操作日誌
router.get('/operation-logs', requireAuth, requireAdmin, (req, res) => {
    const { limit = 100, offset = 0, entity_type, action: actionFilter } = req.query;
    const sendError = (msg, err) => {
        logger.error(msg, err);
        res.status(500).json({ error: '查詢失敗', details: (err && err.message) || msg });
    };
    db.run(OPERATION_LOGS_TABLE_SQL, [], function(createErr) {
        if (createErr) {
            sendError('建立操作日誌表失敗:', createErr);
            return;
        }
        let query = 'SELECT * FROM operation_logs WHERE 1=1';
        const params = [];
        if (entity_type) {
            query += ' AND entity_type = ?';
            params.push(entity_type);
        }
        if (actionFilter) {
            query += ' AND action = ?';
            params.push(actionFilter);
        }
        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit, 10), parseInt(offset, 10));
        db.all(query, params, (err, rows) => {
            if (err) {
                sendError('查詢操作日誌錯誤:', err);
                return;
            }
            const data = (rows || []).map(row => {
                let before_data = null, after_data = null;
                try {
                    if (row.before_data) before_data = JSON.parse(row.before_data);
                    if (row.after_data) after_data = JSON.parse(row.after_data);
                } catch (e) { /* 忽略解析錯誤 */ }
                return {
                    id: row.id,
                    created_at: row.created_at,
                    user_id: row.user_id,
                    username: row.username,
                    action: row.action,
                    entity_type: row.entity_type,
                    entity_id: row.entity_id,
                    before_data,
                    after_data,
                    summary: row.summary
                };
            });
            res.json({ data });
        });
    });
});

// 列出所有備份檔案
router.get('/backups', requireAuth, requireAdmin, (req, res) => {
    const deployPath = process.env.DEPLOY_PATH || path.join(__dirname, '..');
    const backupPaths = [];
    if (process.env.BACKUP_PATH) {
        backupPaths.push(process.env.BACKUP_PATH);
    }
    const defaultBackups = path.join(deployPath, 'backups');
    if (!backupPaths.includes(defaultBackups)) {
        backupPaths.push(defaultBackups);
    }

    const backups = [];

    backupPaths.forEach(backupPath => {
        if (!fs.existsSync(backupPath)) {
            return;
        }

        const source = backupPath.includes('/opt/') ? 'system' : 'local';

        try {
            const files = fs.readdirSync(backupPath);
            files.filter(file => file.endsWith('.db')).forEach(file => {
                const filepath = path.join(backupPath, file);
                try {
                    const stats = fs.statSync(filepath);
                    backups.push({
                        filename: file,
                        filepath: filepath,
                        source: source,
                        size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
                        sizeBytes: stats.size,
                        created: stats.mtime
                    });
                } catch (err) {
                    // 忽略無法讀取的檔案
                }
            });
        } catch (err) {
            // 忽略無法讀取的目錄
        }
    });

    backups.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ data: backups });
});

// 創建新備份（手動「立即備份」；排程自動備份呼叫的是同一支 utils/backup.js 的 createBackup()）
router.post('/backup', requireAuth, requireAdmin, async (req, res) => {
    try {
        const backup = await createBackup();
        res.json({ success: true, message: '備份建立成功', backup });
    } catch (err) {
        logger.error('備份失敗:', err);
        res.status(500).json({ error: '備份失敗', details: err.message });
    }
});

// 下載備份檔案
router.post('/backup/download', requireAuth, requireAdmin, (req, res) => {
    const { filepath } = req.body;
    if (!filepath || typeof filepath !== 'string') {
        return res.status(400).json({ error: '請提供備份檔案路徑' });
    }
    const deployPath = process.env.DEPLOY_PATH || path.join(__dirname, '..');
    const backupPaths = [];
    if (process.env.BACKUP_PATH) backupPaths.push(path.resolve(process.env.BACKUP_PATH));
    backupPaths.push(path.resolve(deployPath, 'backups'));
    const resolved = path.resolve(filepath);
    const allowed = backupPaths.some(base => resolved.startsWith(base));
    if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return res.status(404).json({ error: '找不到備份檔案' });
    }
    const filename = path.basename(resolved);
    res.download(resolved, filename, err => {
        if (err) logger.error('下載備份失敗:', err);
    });
});

// 還原備份
router.post('/restore', requireAuth, requireAdmin, (req, res) => {
    const { filepath } = req.body;

    if (!filepath || typeof filepath !== 'string') {
        return res.status(400).json({ error: '請提供備份檔案路徑' });
    }

    // 還原來源必須落在設定的備份目錄內，避免任意檔案路徑被拿來覆蓋正式資料庫
    // （與 /backup/download 使用同一套白名單邏輯）
    const deployPath = process.env.DEPLOY_PATH || path.join(__dirname, '..');
    const backupPaths = [];
    if (process.env.BACKUP_PATH) backupPaths.push(path.resolve(process.env.BACKUP_PATH));
    backupPaths.push(path.resolve(deployPath, 'backups'));
    const resolved = path.resolve(filepath);
    const allowed = backupPaths.some(base => resolved.startsWith(base));

    if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return res.status(404).json({ error: '找不到備份檔案' });
    }

    const dbPath = path.join(__dirname, '..', 'database', 'fund_report.db');

    const preRestoreBackup = path.join(
        path.dirname(dbPath),
        `fund_report_pre_restore_${Date.now()}.db`
    );

    try {
        if (fs.existsSync(dbPath)) {
            fs.copyFileSync(dbPath, preRestoreBackup);
        }

        fs.copyFileSync(resolved, dbPath);

        res.json({
            success: true,
            message: '備份還原成功，建議重新啟動伺服器以確保資料正確載入'
        });
    } catch (error) {
        logger.error('還原失敗:', error);

        if (fs.existsSync(preRestoreBackup)) {
            try {
                fs.copyFileSync(preRestoreBackup, dbPath);
            } catch (restoreError) {
                logger.error('恢復原資料庫失敗:', restoreError);
            }
        }

        res.status(500).json({ error: '還原失敗', details: error.message });
    }
});

// 取得 M365 / Entra ID SSO 設定
router.get('/sso-settings', requireAuth, requireAdmin, (req, res) => {
    res.json({
        tenantId: entraTenantId(),
        clientId: entraClientId(),
        enabled: ssoConfigured(),
        source: isOverriddenInDb() ? 'database' : (envHasValue() ? 'env' : 'none')
    });
});

// 更新 M365 / Entra ID SSO 設定（存入資料庫並立即生效，不需重啟服務）
router.put('/sso-settings', requireAuth, requireAdmin, async (req, res) => {
    const tenantId = (req.body.tenantId || '').trim();
    const clientId = (req.body.clientId || '').trim();

    try {
        const beforeData = { tenantId: entraTenantId(), clientId: entraClientId() };
        await saveSsoSettings(tenantId, clientId);
        writeOperationLog(req, 'update', 'system_settings', 'entra_sso', beforeData, { tenantId, clientId }, 'M365 SSO 設定已更新');
        res.json({ success: true, message: 'SSO 設定已更新', enabled: ssoConfigured() });
    } catch (error) {
        logger.error('更新 SSO 設定失敗:', error);
        res.status(500).json({ error: '更新失敗', details: error.message });
    }
});

// 取得自動備份排程設定
router.get('/backup-schedule', requireAuth, requireAdmin, (req, res) => {
    res.json(backupScheduler.getSettings());
});

// 更新自動備份排程設定（存入資料庫並立即生效，不需重啟服務）
router.put('/backup-schedule', requireAuth, requireAdmin, async (req, res) => {
    const enabled = req.body.enabled === true;
    const hour = parseInt(req.body.hour, 10);
    const minute = parseInt(req.body.minute, 10);
    const retentionCount = parseInt(req.body.retentionCount, 10);

    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return res.status(400).json({ error: 'hour 必須是 0-23 的整數' });
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        return res.status(400).json({ error: 'minute 必須是 0-59 的整數' });
    }
    if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 365) {
        return res.status(400).json({ error: 'retentionCount 必須是 1-365 的整數' });
    }

    try {
        const beforeData = backupScheduler.getSettings();
        await backupScheduler.saveSettings({ enabled, hour, minute, retentionCount });
        const afterData = backupScheduler.getSettings();
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        writeOperationLog(
            req, 'update', 'system_settings', 'backup_schedule',
            beforeData, afterData,
            `自動備份排程已更新：${enabled ? '啟用' : '停用'}，時間 ${timeStr}，保留 ${retentionCount} 份`
        );
        res.json({ success: true, message: '自動備份排程已更新', ...afterData });
    } catch (error) {
        logger.error('更新自動備份排程失敗:', error);
        res.status(500).json({ error: '更新失敗', details: error.message });
    }
});

module.exports = router;
