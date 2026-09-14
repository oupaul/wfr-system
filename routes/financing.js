const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { requireEditor } = require('../middleware/auth');

// 目前本金餘額 = 原始本金 - 已還本金總額，即時計算不存欄位，避免跟還款記錄兜不起來
const REMAINING_PRINCIPAL_SQL = `
    (f.principal_amount - COALESCE((
        SELECT SUM(fr.principal_paid) FROM financing_repayments fr WHERE fr.financing_id = f.id
    ), 0))
`;

// 取得所有借款/融資額度
router.get('/', (req, res) => {
    const { company_id, active } = req.query;
    let query = `
        SELECT f.*, c.name as company_name, ba.account_name as bank_account_name,
               ba.bank_name as bank_account_bank_name,
               ${REMAINING_PRINCIPAL_SQL} as remaining_principal
        FROM financing f
        LEFT JOIN companies c ON f.company_id = c.id
        LEFT JOIN bank_accounts ba ON f.bank_account_id = ba.id
        WHERE 1=1
    `;
    const params = [];

    if (company_id) {
        query += ' AND f.company_id = ?';
        params.push(company_id);
    }
    if (active !== undefined) {
        query += ' AND f.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY f.is_active DESC, f.maturity_date IS NULL, f.maturity_date ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得單一借款/融資額度
router.get('/:id', (req, res) => {
    const { id } = req.params;
    db.get(
        `SELECT f.*, c.name as company_name, ba.account_name as bank_account_name,
                ba.bank_name as bank_account_bank_name,
                ${REMAINING_PRINCIPAL_SQL} as remaining_principal
         FROM financing f
         LEFT JOIN companies c ON f.company_id = c.id
         LEFT JOIN bank_accounts ba ON f.bank_account_id = ba.id
         WHERE f.id = ?`,
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

// 新增借款/融資額度
router.post('/', requireEditor, (req, res) => {
    const {
        company_id, bank_account_id, facility_name, facility_type, lender,
        total_limit, principal_amount, interest_rate, start_date, maturity_date,
        repayment_method, next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active
    } = req.body;

    if (!facility_name) {
        return res.status(400).json({ error: 'facility_name 為必填欄位' });
    }

    db.run(
        `INSERT INTO financing
         (company_id, bank_account_id, facility_name, facility_type, lender, total_limit,
          principal_amount, interest_rate, start_date, maturity_date, repayment_method,
          next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            company_id || null, bank_account_id || null, facility_name, facility_type || '短期借款',
            lender || null, total_limit != null && total_limit !== '' ? total_limit : null,
            principal_amount || 0, interest_rate != null && interest_rate !== '' ? interest_rate : null,
            start_date || null, maturity_date || null, repayment_method || null,
            next_payment_date || null, next_payment_amount != null && next_payment_amount !== '' ? next_payment_amount : null,
            repayment_frequency || null,
            remarks || null, is_active !== undefined ? is_active : 1
        ],
        function (err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, company_id: company_id || null, facility_name, facility_type: facility_type || '短期借款' };
            writeOperationLog(req, 'create', 'financing', newId, null, afterData, '借款/額度 #' + newId + ' ' + (facility_name || ''));
            res.json({ success: true, id: newId, message: '借款/額度已新增' });
        }
    );
});

// 更新借款/融資額度
router.put('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    const {
        company_id, bank_account_id, facility_name, facility_type, lender,
        total_limit, principal_amount, interest_rate, start_date, maturity_date,
        repayment_method, next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active
    } = req.body;

    if (!facility_name) {
        return res.status(400).json({ error: 'facility_name 為必填欄位' });
    }

    db.get('SELECT * FROM financing WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = {
            id: parseInt(id, 10), company_id: company_id || null, bank_account_id: bank_account_id || null,
            facility_name, facility_type: facility_type || '短期借款', lender: lender || null,
            total_limit: total_limit != null && total_limit !== '' ? total_limit : null,
            principal_amount: principal_amount || 0,
            interest_rate: interest_rate != null && interest_rate !== '' ? interest_rate : null,
            start_date: start_date || null, maturity_date: maturity_date || null,
            repayment_method: repayment_method || null, next_payment_date: next_payment_date || null,
            next_payment_amount: next_payment_amount != null && next_payment_amount !== '' ? next_payment_amount : null,
            repayment_frequency: repayment_frequency || null,
            remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1
        };
        db.run(
            `UPDATE financing SET company_id = ?, bank_account_id = ?, facility_name = ?, facility_type = ?,
                lender = ?, total_limit = ?, principal_amount = ?, interest_rate = ?, start_date = ?,
                maturity_date = ?, repayment_method = ?, next_payment_date = ?, next_payment_amount = ?,
                repayment_frequency = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                afterData.company_id, afterData.bank_account_id, afterData.facility_name, afterData.facility_type,
                afterData.lender, afterData.total_limit, afterData.principal_amount, afterData.interest_rate,
                afterData.start_date, afterData.maturity_date, afterData.repayment_method,
                afterData.next_payment_date, afterData.next_payment_amount, afterData.repayment_frequency,
                afterData.remarks, afterData.is_active,
                id
            ],
            function (updateErr) {
                if (updateErr) {
                    logger.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'financing', id, oldRow, afterData, '借款/額度 #' + id + ' ' + (facility_name || ''));
                res.json({ success: true, message: '借款/額度已更新' });
            }
        );
    });
});

// 刪除借款/融資額度（先刪還款記錄——這個專案沒有開啟 PRAGMA foreign_keys，
// ON DELETE CASCADE 不會真的生效，必須手動清掉子記錄）
router.delete('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM financing WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM financing_repayments WHERE financing_id = ?', [id], (repayDelErr) => {
            if (repayDelErr) {
                logger.error('刪除還款記錄錯誤:', repayDelErr);
                return res.status(500).json({ error: '刪除失敗', details: repayDelErr.message });
            }
            db.run('DELETE FROM financing WHERE id = ?', [id], function (delErr) {
                if (delErr) {
                    logger.error('刪除錯誤:', delErr);
                    return res.status(500).json({ error: '刪除失敗', details: delErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'delete', 'financing', id, row, null, '借款/額度 #' + id + ' ' + (row.facility_name || ''));
                res.json({ success: true, message: '借款/額度已刪除' });
            });
        });
    });
});

// ==================== 還款記錄 ====================

// 取得某筆借款的還款歷史
router.get('/:id/repayments', (req, res) => {
    const { id } = req.params;
    db.all(
        'SELECT * FROM financing_repayments WHERE financing_id = ? ORDER BY payment_date DESC, id DESC',
        [id],
        (err, rows) => {
            if (err) {
                logger.error('查詢還款記錄錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows, count: rows.length });
        }
    );
});

// 新增一筆還款記錄
router.post('/:id/repayments', requireEditor, (req, res) => {
    const { id } = req.params;
    const { payment_date, principal_paid, interest_paid, remarks } = req.body;

    if (!payment_date) {
        return res.status(400).json({ error: 'payment_date 為必填欄位' });
    }

    db.get('SELECT id, facility_name FROM financing WHERE id = ?', [id], (err, financingRow) => {
        if (err || !financingRow) {
            if (!financingRow) return res.status(404).json({ error: '找不到借款記錄' });
            return res.status(500).json({ error: '新增失敗', details: err && err.message });
        }

        db.run(
            `INSERT INTO financing_repayments (financing_id, payment_date, principal_paid, interest_paid, remarks)
             VALUES (?, ?, ?, ?, ?)`,
            [id, payment_date, principal_paid || 0, interest_paid || 0, remarks || null],
            function (insertErr) {
                if (insertErr) {
                    logger.error('新增還款記錄錯誤:', insertErr);
                    return res.status(500).json({ error: '新增失敗', details: insertErr.message });
                }
                const newId = this.lastID;
                const afterData = { id: newId, financing_id: parseInt(id, 10), payment_date, principal_paid: principal_paid || 0, interest_paid: interest_paid || 0, remarks: remarks || null };
                writeOperationLog(req, 'create', 'financing_repayment', newId, null, afterData, '還款記錄 #' + newId + '（' + (financingRow.facility_name || '') + '）');
                res.json({ success: true, id: newId, message: '還款記錄已新增' });
            }
        );
    });
});

// 刪除一筆還款記錄
router.delete('/:id/repayments/:repaymentId', requireEditor, (req, res) => {
    const { id, repaymentId } = req.params;
    db.get('SELECT * FROM financing_repayments WHERE id = ? AND financing_id = ?', [repaymentId, id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到還款記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM financing_repayments WHERE id = ?', [repaymentId], function (delErr) {
            if (delErr) {
                logger.error('刪除還款記錄錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到還款記錄' });
            writeOperationLog(req, 'delete', 'financing_repayment', repaymentId, row, null, '還款記錄 #' + repaymentId);
            res.json({ success: true, message: '還款記錄已刪除' });
        });
    });
});

module.exports = router;
