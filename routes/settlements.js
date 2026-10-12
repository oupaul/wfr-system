const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin, requireEditor } = require('../middleware/auth');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');
const { calculateSettlement } = require('../utils/settlementCalc');

// 取得所有結算記錄
// bank_name / account_type 透過比對 bank_accounts 查出來（balance_settlements
// 本身沒有存這兩個欄位，做法跟 transactions 比對的方式一致）
router.get('/', (req, res) => {
    const { startDate, endDate, company, company_name, account, account_name, account_number, limit = 100, offset = 0, order } = req.query;

    let baseQuery = `
        FROM balance_settlements bs
        LEFT JOIN companies c ON c.name = bs.company_name
        LEFT JOIN bank_accounts ba ON ba.company_id = c.id
            AND ba.account_name = bs.account_name
            AND (ba.account_number = bs.account_number OR ba.account_number IS NULL OR bs.account_number IS NULL)
        WHERE 1=1
    `;
    const params = [];

    if (startDate) {
        baseQuery += ' AND bs.settlement_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        baseQuery += ' AND bs.settlement_date <= ?';
        params.push(endDate);
    }
    const companyParam = company_name || company;
    if (companyParam) {
        baseQuery += ' AND bs.company_name = ?';
        params.push(companyParam);
    }
    if (account) {
        baseQuery += ' AND (bs.account_name LIKE ? OR bs.account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }
    if (account_name) {
        baseQuery += ' AND bs.account_name = ?';
        params.push(account_name);
    }
    if (account_number) {
        baseQuery += ' AND bs.account_number = ?';
        params.push(account_number);
    }

    db.get(`SELECT COUNT(*) as total ${baseQuery}`, params, (countErr, countRow) => {
        if (countErr) {
            logger.error('查詢錯誤:', countErr);
            return res.status(500).json({ error: '查詢失敗', details: countErr.message });
        }

        const dataQuery = `SELECT bs.*, ba.bank_name, ba.account_type ${baseQuery} ORDER BY bs.settlement_date DESC, bs.id DESC LIMIT ? OFFSET ?`;
        const dataParams = [...params, parseInt(limit), parseInt(offset)];

        db.all(dataQuery, dataParams, (err, rows) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows, count: rows.length, total: countRow ? countRow.total : rows.length });
        });
    });
});

// 取得上一次結算日期（必須在 /:id 之前）
router.get('/last', (req, res) => {
    const { company, account_name, account_number } = req.query;

    let query = `
        SELECT * FROM balance_settlements 
        WHERE 1=1
    `;
    const params = [];

    if (company) {
        query += ' AND company_name = ?';
        params.push(company);
    }
    if (account_name) {
        query += ' AND account_name = ?';
        params.push(account_name);
    }
    if (account_number) {
        query += ' AND (account_number = ? OR account_number IS NULL)';
        params.push(account_number);
    }

    query += ' ORDER BY settlement_date DESC LIMIT 1';

    db.get(query, params, (err, row) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: row || null });
    });
});

// 計算結算（必須在 /:id 之前）
router.post('/calculate', async (req, res) => {
    const { settlement_date, company_name, account_name, account_number } = req.body;

    if (!settlement_date || !company_name) {
        return res.status(400).json({ error: 'settlement_date 和 company_name 為必填欄位' });
    }
    try {
        // 計算規則見 utils/settlementCalc.js：實際餘額＝結算日當天開始前的餘額，跟資金流水帳一致
        const data = await calculateSettlement({ settlement_date, company_name, account_name, account_number });
        res.json({ data });
    } catch (err) {
        logger.error('計算結算錯誤:', err);
        res.status(500).json({ error: '計算失敗', details: err.message });
    }
});

// 新增結算記錄
router.post('/', requireEditor, (req, res) => {
    const {
        settlement_date,
        company_name,
        account_name,
        account_number,
        actual_balance,
        remarks
    } = req.body;

    if (!settlement_date || !company_name || actual_balance === undefined) {
        return res.status(400).json({ error: 'settlement_date、company_name 和 actual_balance 為必填欄位' });
    }

    const calculatePromise = calculateSettlement({ settlement_date, company_name, account_name, account_number })
        .then((c) => ({
            previous_settlement_date: c.previous_settlement_date,
            opening_balance: c.opening_balance,
            total_income: c.total_income,
            total_expense: c.total_expense,
            calculated_balance: c.calculated_balance,
            difference: parseFloat(actual_balance) - c.calculated_balance
        }));

    calculatePromise.then(calcData => {
        db.run(
            `INSERT INTO balance_settlements 
             (settlement_date, company_name, account_name, account_number, 
              previous_settlement_date, opening_balance, total_income, total_expense, 
              calculated_balance, actual_balance, difference, remarks) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [settlement_date, company_name, account_name || null, account_number || null,
             calcData.previous_settlement_date, calcData.opening_balance, calcData.total_income,
             calcData.total_expense, calcData.calculated_balance, parseFloat(actual_balance),
             calcData.difference, remarks || null],
            async function(err) {
                if (err) {
                    logger.error('新增結算錯誤:', err);
                    return res.status(500).json({ error: '新增失敗', details: err.message });
                }

                const newId = this.lastID;
                const afterData = { id: newId, settlement_date, company_name, account_name: account_name || null, account_number: account_number || null, previous_settlement_date: calcData.previous_settlement_date, opening_balance: calcData.opening_balance, total_income: calcData.total_income, total_expense: calcData.total_expense, calculated_balance: calcData.calculated_balance, actual_balance: parseFloat(actual_balance), difference: calcData.difference, remarks: remarks || null };
                writeOperationLog(req, 'create', 'settlement', newId, null, afterData, '結算 #' + newId + ' ' + (settlement_date || ''));
                try {
                    if (account_name) {
                        await updateBankAccountBalance(account_name, account_number, company_name || null);
                    }
                } catch (error) {
                    logger.error('更新帳戶餘額失敗:', error);
                }

                res.json({
                    success: true,
                    id: newId,
                    message: '結算記錄已新增',
                    data: { ...calcData, id: newId }
                });
            }
        );
    }).catch(err => {
        logger.error('計算結算數據錯誤:', err);
        res.status(500).json({ error: '計算失敗', details: err.message });
    });
});

// 取得單一結算記錄
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, row) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        res.json({ data: row });
    });
});

// 更新結算記錄（需要管理員權限）
router.put('/:id', requireAuth, requireEditor, (req, res) => {
    const { id } = req.params;
    const {
        settlement_date,
        company_name,
        account_name,
        account_number,
        actual_balance,
        remarks
    } = req.body;

    if (!settlement_date || !company_name || actual_balance === undefined) {
        return res.status(400).json({ error: 'settlement_date、company_name 和 actual_balance 為必填欄位' });
    }

    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, oldRow) => {
        if (err) {
            logger.error('查詢舊記錄錯誤:', err);
            return res.status(500).json({ error: '更新失敗', details: err.message });
        }
        if (!oldRow) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const oldSettlement = oldRow;
        const oldAccountName = oldSettlement.account_name;
        const oldAccountNumber = oldSettlement.account_number;

        const calculatePromise = calculateSettlement({ settlement_date, company_name, account_name, account_number }, id)
            .then((c) => ({
                previous_settlement_date: c.previous_settlement_date,
                opening_balance: c.opening_balance,
                total_income: c.total_income,
                total_expense: c.total_expense,
                calculated_balance: c.calculated_balance,
                difference: parseFloat(actual_balance) - c.calculated_balance
            }));

        calculatePromise.then(calcData => {
            db.run(
                `UPDATE balance_settlements 
                 SET settlement_date = ?, company_name = ?, account_name = ?, account_number = ?, 
                     previous_settlement_date = ?, opening_balance = ?, total_income = ?, total_expense = ?, 
                     calculated_balance = ?, actual_balance = ?, difference = ?, remarks = ?, 
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [settlement_date, company_name, account_name || null, account_number || null,
                 calcData.previous_settlement_date, calcData.opening_balance, calcData.total_income,
                 calcData.total_expense, calcData.calculated_balance, parseFloat(actual_balance),
                 calcData.difference, remarks || null, id],
                async function(err) {
                    if (err) {
                        logger.error('更新結算錯誤:', err);
                        return res.status(500).json({ error: '更新失敗', details: err.message });
                    }
                    if (this.changes === 0) {
                        return res.status(404).json({ error: '找不到記錄' });
                    }
                    const afterData = {
                        id: parseInt(id, 10),
                        settlement_date,
                        company_name,
                        account_name: account_name || null,
                        account_number: account_number || null,
                        previous_settlement_date: calcData.previous_settlement_date,
                        opening_balance: calcData.opening_balance,
                        total_income: calcData.total_income,
                        total_expense: calcData.total_expense,
                        calculated_balance: calcData.calculated_balance,
                        actual_balance: parseFloat(actual_balance),
                        difference: calcData.difference,
                        remarks: remarks || null
                    };
                    writeOperationLog(req, 'update', 'settlement', id, oldRow, afterData, '結算 #' + id + ' ' + (settlement_date || ''));
                    try {
                        const oldCompanyName = oldSettlement.company_name;
                        const accountChanged = oldAccountName !== account_name || oldAccountNumber !== account_number;
                        if (accountChanged && oldAccountName) {
                            await updateBankAccountBalance(oldAccountName, oldAccountNumber, oldCompanyName || null);
                        }
                        if (account_name) {
                            await updateBankAccountBalance(account_name, account_number, company_name || null);
                        }
                    } catch (error) {
                        logger.error('更新帳戶餘額失敗:', error);
                    }

                    res.json({
                        success: true,
                        message: '結算記錄已更新',
                        data: { ...calcData, id: parseInt(id) }
                    });
                }
            );
        }).catch(err => {
            logger.error('計算結算數據錯誤:', err);
            res.status(500).json({ error: '計算失敗', details: err.message });
        });
    });
});

// 刪除結算記錄
router.delete('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM balance_settlements WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM balance_settlements WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                logger.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'settlement', id, row, null, '結算 #' + id + ' ' + (row.settlement_date || ''));
            res.json({ success: true, message: '記錄已刪除' });
        });
    });
});

module.exports = router;
