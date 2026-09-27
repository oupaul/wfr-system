const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { requireEditor } = require('../middleware/auth');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');
const { recordRepaymentAndSync } = require('../utils/financingRepayment');
const { addMonthsClamped } = require('../utils/financingProjection');

const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

// 取得所有週期性收支範本
router.get('/', (req, res) => {
    const { active } = req.query;
    let query = `
        SELECT rt.*, f.facility_name as financing_facility_name
        FROM recurring_transactions rt
        LEFT JOIN financing f ON rt.financing_id = f.id
        WHERE 1=1
    `;
    const params = [];
    if (active !== undefined) {
        query += ' AND rt.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }
    query += ' ORDER BY rt.is_active DESC, rt.next_run_date IS NULL, rt.next_run_date ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得單一範本
router.get('/:id', (req, res) => {
    db.get(
        `SELECT rt.*, f.facility_name as financing_facility_name
         FROM recurring_transactions rt
         LEFT JOIN financing f ON rt.financing_id = f.id
         WHERE rt.id = ?`,
        [req.params.id],
        (err, row) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            res.json({ data: row });
        }
    );
});

// 連結借款時驗證本金+利息合計等於金額（容忍浮點數誤差）
function validateFinancingSplit(body) {
    if (!body.financing_id) return null;
    const amount = parseFloat(body.amount) || 0;
    const principal = parseFloat(body.principal_amount) || 0;
    const interest = parseFloat(body.interest_amount) || 0;
    if (Math.abs(amount - (principal + interest)) > 0.01) {
        return '連結借款時，本金 + 利息必須等於金額';
    }
    return null;
}

// 新增範本
router.post('/', requireEditor, (req, res) => {
    const {
        type, amount, category, description, company_name, account_name, account_number, remarks,
        frequency, next_run_date, end_date, financing_id, principal_amount, interest_amount
    } = req.body;

    if (!type || amount === undefined || !frequency) {
        return res.status(400).json({ error: 'type、amount、frequency 為必填欄位' });
    }
    const splitError = validateFinancingSplit(req.body);
    if (splitError) return res.status(400).json({ error: splitError });

    db.run(
        `INSERT INTO recurring_transactions
         (type, amount, category, description, company_name, account_name, account_number, remarks,
          frequency, next_run_date, end_date, financing_id, principal_amount, interest_amount, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
            type, amount, category || null, description || null, company_name || null, account_name || null,
            account_number || null, remarks || null, frequency, next_run_date || null, end_date || null,
            financing_id || null, financing_id ? (principal_amount || 0) : null, financing_id ? (interest_amount || 0) : null
        ],
        function (err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            writeOperationLog(req, 'create', 'recurring_transaction', newId, null, { id: newId, type, amount, description: description || null }, '週期範本 #' + newId + ' ' + (description || category || ''));
            res.json({ success: true, id: newId, message: '範本已新增' });
        }
    );
});

// 更新範本
router.put('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    const {
        type, amount, category, description, company_name, account_name, account_number, remarks,
        frequency, next_run_date, end_date, financing_id, principal_amount, interest_amount, is_active
    } = req.body;

    if (!type || amount === undefined || !frequency) {
        return res.status(400).json({ error: 'type、amount、frequency 為必填欄位' });
    }
    const splitError = validateFinancingSplit(req.body);
    if (splitError) return res.status(400).json({ error: splitError });

    db.get('SELECT * FROM recurring_transactions WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = {
            id: parseInt(id, 10), type, amount, category: category || null, description: description || null,
            company_name: company_name || null, account_name: account_name || null, account_number: account_number || null,
            remarks: remarks || null, frequency, next_run_date: next_run_date || null, end_date: end_date || null,
            financing_id: financing_id || null, principal_amount: financing_id ? (principal_amount || 0) : null,
            interest_amount: financing_id ? (interest_amount || 0) : null, is_active: is_active !== undefined ? is_active : 1
        };
        db.run(
            `UPDATE recurring_transactions SET type = ?, amount = ?, category = ?, description = ?, company_name = ?,
                account_name = ?, account_number = ?, remarks = ?, frequency = ?, next_run_date = ?, end_date = ?,
                financing_id = ?, principal_amount = ?, interest_amount = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                afterData.type, afterData.amount, afterData.category, afterData.description, afterData.company_name,
                afterData.account_name, afterData.account_number, afterData.remarks, afterData.frequency,
                afterData.next_run_date, afterData.end_date, afterData.financing_id, afterData.principal_amount,
                afterData.interest_amount, afterData.is_active, id
            ],
            function (updateErr) {
                if (updateErr) {
                    logger.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'recurring_transaction', id, oldRow, afterData, '週期範本 #' + id + ' ' + (description || category || ''));
                res.json({ success: true, message: '範本已更新' });
            }
        );
    });
});

// 刪除範本
router.delete('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM recurring_transactions WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM recurring_transactions WHERE id = ?', [id], function (delErr) {
            if (delErr) {
                logger.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'recurring_transaction', id, row, null, '週期範本 #' + id);
            res.json({ success: true, message: '範本已刪除' });
        });
    });
});

// 產生下一筆：實際寫入一筆收支記錄，連結借款時一併記還款記錄，
// 最後把 next_run_date 往後推一期（或超過 end_date 時自動停用）
router.post('/:id/generate', requireEditor, async (req, res) => {
    const { id } = req.params;

    try {
        const template = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM recurring_transactions WHERE id = ?', [id], (err, row) => (err ? reject(err) : resolve(row)));
        });
        if (!template) return res.status(404).json({ error: '找不到範本' });
        if (!template.is_active) return res.status(400).json({ error: '此範本已停用' });
        if (!template.next_run_date) return res.status(400).json({ error: '此範本沒有排定下次產生日期' });
        if (template.end_date && template.next_run_date > template.end_date) {
            return res.status(400).json({ error: '此範本已超過到期日' });
        }

        const runDate = template.next_run_date;

        const transactionId = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO transactions
                 (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [runDate, template.type, template.amount, template.category || null, template.description || null,
                 template.company_name || null, template.account_name || null, template.account_number || null, template.remarks || null],
                function (err) { err ? reject(err) : resolve(this.lastID); }
            );
        });
        writeOperationLog(req, 'create', 'transaction', transactionId, null,
            { id: transactionId, transaction_date: runDate, type: template.type, amount: template.amount },
            '收支記錄 #' + transactionId + '（週期範本 #' + id + ' 產生）');

        if (template.account_name) {
            try {
                await updateBankAccountBalance(template.account_name, template.account_number, template.company_name || null);
            } catch (balanceErr) {
                logger.error('更新帳戶餘額失敗:', balanceErr);
            }
        }

        let repaymentId = null;
        if (template.financing_id) {
            try {
                const result = await recordRepaymentAndSync(db, template.financing_id, {
                    payment_date: runDate,
                    principal_paid: template.principal_amount || 0,
                    interest_paid: template.interest_amount || 0,
                    remarks: '（週期範本自動產生）' + (template.remarks || '')
                });
                repaymentId = result.repaymentId;
                writeOperationLog(req, 'create', 'financing_repayment', repaymentId, null,
                    { id: repaymentId, financing_id: template.financing_id, payment_date: runDate },
                    '還款記錄 #' + repaymentId + '（週期範本 #' + id + ' 產生，' + (result.facilityName || '') + '）');
            } catch (financingErr) {
                logger.error('同步借款還款記錄失敗:', financingErr);
            }
        }

        // 推算下一次產生日；超過 end_date 就清空並停用，範本自然到期
        const stepMonths = STEP_MONTHS[template.frequency] || 1;
        const nextRunDate = addMonthsClamped(runDate, stepMonths);
        const exceedsEndDate = template.end_date && nextRunDate > template.end_date;

        await new Promise((resolve, reject) => {
            if (exceedsEndDate) {
                db.run('UPDATE recurring_transactions SET next_run_date = NULL, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id], (err) => (err ? reject(err) : resolve()));
            } else {
                db.run('UPDATE recurring_transactions SET next_run_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextRunDate, id], (err) => (err ? reject(err) : resolve()));
            }
        });

        res.json({
            success: true,
            transactionId,
            repaymentId,
            nextRunDate: exceedsEndDate ? null : nextRunDate,
            deactivated: !!exceedsEndDate,
            message: '已產生一筆收支記錄' + (repaymentId ? '，並同步還款記錄' : '')
        });
    } catch (error) {
        logger.error('產生收支記錄錯誤:', error);
        res.status(500).json({ error: '產生失敗', details: error.message });
    }
});

module.exports = router;
