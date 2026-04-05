const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { OPERATION_LOGS_TABLE_SQL } = require('../utils/operationLog');

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

// 創建新備份
router.post('/backup', requireAuth, requireAdmin, (req, res) => {
    const backupDir = process.env.BACKUP_PATH || path.join(__dirname, '..', 'backups');

    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
    const backupFile = path.join(backupDir, `fund_report_${timestamp}.db`);

    db.run('VACUUM INTO ?', [backupFile], (err) => {
        if (err) {
            logger.warn('VACUUM INTO 不支援，改用 WAL checkpoint 備份:', err.message);
            try {
                db.run('PRAGMA wal_checkpoint(FULL)', [], (cpErr) => {
                    if (cpErr) logger.warn('WAL checkpoint 警告:', cpErr.message);
                    try {
                        fs.copyFileSync(path.join(__dirname, '..', 'database', 'fund_report.db'), backupFile);
                        const stats = fs.statSync(backupFile);
                        logger.info(`備份建立成功（fallback）: ${backupFile}`);
                        res.json({
                            success: true,
                            message: '備份建立成功',
                            backup: {
                                filename: path.basename(backupFile),
                                filepath: backupFile,
                                size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
                            }
                        });
                    } catch (copyErr) {
                        logger.error('備份失敗:', copyErr);
                        res.status(500).json({ error: '備份失敗', details: copyErr.message });
                    }
                });
            } catch (fallbackErr) {
                logger.error('備份失敗:', fallbackErr);
                res.status(500).json({ error: '備份失敗', details: fallbackErr.message });
            }
            return;
        }

        try {
            const stats = fs.statSync(backupFile);
            logger.info(`備份建立成功（VACUUM INTO）: ${backupFile}`);
            res.json({
                success: true,
                message: '備份建立成功',
                backup: {
                    filename: path.basename(backupFile),
                    filepath: backupFile,
                    size: `${(stats.size / 1024 / 1024).toFixed(2)} MB`
                }
            });
        } catch (statErr) {
            logger.error('備份狀態讀取失敗:', statErr);
            res.status(500).json({ error: '備份失敗', details: statErr.message });
        }
    });
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

    if (!filepath) {
        return res.status(400).json({ error: '請提供備份檔案路徑' });
    }

    if (!fs.existsSync(filepath)) {
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

        fs.copyFileSync(filepath, dbPath);

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

module.exports = router;
