const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');

// 取得所有銀行帳戶
router.get('/', (req, res) => {
    const { company_id, active } = req.query;
    let query = `
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE 1=1
    `;
    const params = [];

    if (company_id) {
        query += ' AND ba.company_id = ?';
        params.push(company_id);
    }
    if (active !== undefined) {
        query += ' AND ba.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY ba.account_name ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 重新計算所有銀行帳戶即時餘額（必須在 /:id 之前）
router.post('/recalculate-balances', async (req, res) => {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT ba.account_name, ba.account_number, c.name as company_name
                FROM bank_accounts ba
                LEFT JOIN companies c ON ba.company_id = c.id
                WHERE ba.is_active = 1
            `, [], (err, r) => err ? reject(err) : resolve(r || []));
        });
        for (const row of rows) {
            await updateBankAccountBalance(row.account_name, row.account_number, row.company_name || null);
        }
        res.json({ success: true, message: `已重新計算 ${rows.length} 個帳戶餘額` });
    } catch (err) {
        logger.error('重新計算餘額錯誤:', err);
        res.status(500).json({ error: '重新計算失敗', details: err.message });
    }
});

// 取得單一銀行帳戶
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get(
        `SELECT ba.*, c.name as company_name 
         FROM bank_accounts ba
         LEFT JOIN companies c ON ba.company_id = c.id
         WHERE ba.id = ?`,
        [id],
        (err, row) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            res.json({ data: row });
        }
    );
});

// 新增銀行帳戶
router.post('/', (req, res) => {
    const {
        company_id,
        account_name,
        account_number,
        bank_name,
        branch_name,
        account_type,
        currency,
        remarks,
        is_active
    } = req.body;

    if (!account_name) {
        return res.status(400).json({ error: 'account_name 為必填欄位' });
    }

    db.run(
        `INSERT INTO bank_accounts 
         (company_id, account_name, account_number, bank_name, branch_name, account_type, currency, safety_level, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_id || null, account_name, account_number || null, bank_name || null,
         branch_name || null, account_type || null, currency || 'TWD',
         req.body.safety_level !== undefined ? req.body.safety_level : 0,
         remarks || null, is_active !== undefined ? is_active : 1],
        function(err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level: req.body.safety_level !== undefined ? req.body.safety_level : 0, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'bank_account', newId, null, afterData, '銀行帳戶 #' + newId + ' ' + (account_name || ''));
            res.json({ success: true, id: newId, message: '銀行帳戶已新增' });
        }
    );
});

// 更新銀行帳戶
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { company_id, account_name, account_number, bank_name, branch_name, account_type, currency, remarks, is_active } = req.body;
    const safety_level = req.body.safety_level !== undefined ? req.body.safety_level : 0;
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = { id: parseInt(id, 10), company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
        db.run(
            `UPDATE bank_accounts SET company_id = ?, account_name = ?, account_number = ?, bank_name = ?, branch_name = ?, account_type = ?, currency = ?, safety_level = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [company_id || null, account_name, account_number || null, bank_name || null, branch_name || null, account_type || null, currency || 'TWD', safety_level, remarks || null, is_active !== undefined ? is_active : 1, id],
            function(updateErr) {
                if (updateErr) {
                    logger.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'bank_account', id, oldRow, afterData, '銀行帳戶 #' + id + ' ' + (account_name || ''));
                res.json({ success: true, message: '銀行帳戶已更新' });
            }
        );
    });
});

// 刪除銀行帳戶
router.delete('/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM bank_accounts WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                logger.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'bank_account', id, row, null, '銀行帳戶 #' + id + ' ' + (row.account_name || ''));
            res.json({ success: true, message: '銀行帳戶已刪除' });
        });
    });
});

module.exports = router;
