const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');

// 取得所有結算記錄
router.get('/', (req, res) => {
    const { startDate, endDate, company, company_name, account, account_name, account_number, limit = 100, offset = 0, order } = req.query;

    let query = 'SELECT * FROM balance_settlements WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND settlement_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND settlement_date <= ?';
        params.push(endDate);
    }
    const companyParam = company_name || company;
    if (companyParam) {
        query += ' AND company_name = ?';
        params.push(companyParam);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }
    if (account_name) {
        query += ' AND account_name = ?';
        params.push(account_name);
    }
    if (account_number) {
        query += ' AND account_number = ?';
        params.push(account_number);
    }

    query += ' ORDER BY settlement_date DESC, id DESC';
    query += ' LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
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
        query += ' AND account_number = ?';
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
router.post('/calculate', (req, res) => {
    const { settlement_date, company_name, account_name, account_number } = req.body;

    if (!settlement_date || !company_name) {
        return res.status(400).json({ error: 'settlement_date 和 company_name 為必填欄位' });
    }

    let lastSettlementQuery = `
        SELECT * FROM balance_settlements 
        WHERE company_name = ?
    `;
    const lastParams = [company_name];

    if (account_name) {
        lastSettlementQuery += ' AND account_name = ?';
        lastParams.push(account_name);
    }
    if (account_number) {
        lastSettlementQuery += ' AND account_number = ?';
        lastParams.push(account_number);
    }

    lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

    db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
        if (err) {
            logger.error('查詢上一次結算錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }

        const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
        const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

        let transactionQuery = `
            SELECT 
                type,
                SUM(amount) as total
            FROM transactions
            WHERE company_name = ?
            AND transaction_date > ?
            AND transaction_date <= ?
        `;
        const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];

        if (account_name) {
            transactionQuery += ' AND account_name = ?';
            transactionParams.push(account_name);
        } else if (account_number) {
            transactionQuery += ' AND account_number = ?';
            transactionParams.push(account_number);
        }

        transactionQuery += ' GROUP BY type';

        db.all(transactionQuery, transactionParams, (err, transactionRows) => {
            if (err) {
                logger.error('計算收支錯誤:', err);
                return res.status(500).json({ error: '計算失敗', details: err.message });
            }

            let totalIncome = 0;
            let totalExpense = 0;

            if (transactionRows && transactionRows.length > 0) {
                transactionRows.forEach(row => {
                    const total = parseFloat(row.total) || 0;
                    if (row.type === 'income') {
                        totalIncome = total;
                    } else if (row.type === 'expense') {
                        totalExpense = total;
                    }
                });
            }

            logger.info('結算計算結果:', {
                company_name,
                account_name,
                account_number,
                previousDate,
                settlement_date,
                transactionRows: transactionRows || [],
                totalIncome,
                totalExpense
            });

            const calculatedBalance = openingBalance + totalIncome - totalExpense;

            res.json({
                data: {
                    previous_settlement_date: previousDate,
                    opening_balance: openingBalance,
                    total_income: totalIncome,
                    total_expense: totalExpense,
                    calculated_balance: calculatedBalance,
                    period_start: previousDate || '無',
                    period_end: settlement_date
                }
            });
        });
    });
});

// 新增結算記錄
router.post('/', (req, res) => {
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

    const calculatePromise = new Promise((resolve, reject) => {
        let lastSettlementQuery = `
            SELECT * FROM balance_settlements 
            WHERE company_name = ?
        `;
        const lastParams = [company_name];

        if (account_name) {
            lastSettlementQuery += ' AND account_name = ?';
            lastParams.push(account_name);
        }
        if (account_number) {
            lastSettlementQuery += ' AND account_number = ?';
            lastParams.push(account_number);
        }

        lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

        db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
            if (err) {
                return reject(err);
            }

            const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
            const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

            let transactionQuery = `
                SELECT 
                    type,
                    SUM(amount) as total
                FROM transactions
                WHERE company_name = ?
                AND transaction_date > ?
                AND transaction_date <= ?
            `;
            const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];

            if (account_name && account_number) {
                transactionQuery += ' AND account_name = ? AND account_number = ?';
                transactionParams.push(account_name, account_number);
            } else if (account_name) {
                transactionQuery += ' AND account_name = ?';
                transactionParams.push(account_name);
            } else if (account_number) {
                transactionQuery += ' AND account_number = ?';
                transactionParams.push(account_number);
            }

            transactionQuery += ' GROUP BY type';

            db.all(transactionQuery, transactionParams, (err, transactionRows) => {
                if (err) {
                    return reject(err);
                }

                let totalIncome = 0;
                let totalExpense = 0;

                if (transactionRows && transactionRows.length > 0) {
                    transactionRows.forEach(row => {
                        const total = parseFloat(row.total) || 0;
                        if (row.type === 'income') {
                            totalIncome = total;
                        } else if (row.type === 'expense') {
                            totalExpense = total;
                        }
                    });
                }

                logger.info('結算計算結果（儲存時）:', {
                    company_name,
                    account_name,
                    account_number,
                    previousDate,
                    settlement_date,
                    transactionRows: transactionRows || [],
                    totalIncome,
                    totalExpense
                });

                const calculatedBalance = openingBalance + totalIncome - totalExpense;
                const actualBal = parseFloat(actual_balance);
                const difference = actualBal - calculatedBalance;

                resolve({
                    previous_settlement_date: previousDate,
                    opening_balance: openingBalance,
                    total_income: totalIncome,
                    total_expense: totalExpense,
                    calculated_balance: calculatedBalance,
                    difference: difference
                });
            });
        });
    });

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
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
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

        const calculatePromise = new Promise((resolve, reject) => {
            let lastSettlementQuery = `
                SELECT * FROM balance_settlements 
                WHERE company_name = ?
                AND id != ?
            `;
            const lastParams = [company_name, id];

            if (account_name) {
                lastSettlementQuery += ' AND account_name = ?';
                lastParams.push(account_name);
            }
            if (account_number) {
                lastSettlementQuery += ' AND account_number = ?';
                lastParams.push(account_number);
            }

            lastSettlementQuery += ' ORDER BY settlement_date DESC LIMIT 1';

            db.get(lastSettlementQuery, lastParams, (err, lastSettlement) => {
                if (err) {
                    return reject(err);
                }

                const previousDate = lastSettlement ? lastSettlement.settlement_date : null;
                const openingBalance = lastSettlement ? parseFloat(lastSettlement.actual_balance) : 0;

                let transactionQuery = `
                    SELECT 
                        type,
                        SUM(amount) as total
                    FROM transactions
                    WHERE company_name = ?
                    AND transaction_date > ?
                    AND transaction_date <= ?
                `;
                const transactionParams = [company_name, previousDate || '1900-01-01', settlement_date];

                if (account_name && account_number) {
                    transactionQuery += ' AND account_name = ? AND account_number = ?';
                    transactionParams.push(account_name, account_number);
                } else if (account_name) {
                    transactionQuery += ' AND account_name = ?';
                    transactionParams.push(account_name);
                } else if (account_number) {
                    transactionQuery += ' AND account_number = ?';
                    transactionParams.push(account_number);
                }

                transactionQuery += ' GROUP BY type';

                db.all(transactionQuery, transactionParams, (err, transactionRows) => {
                    if (err) {
                        return reject(err);
                    }

                    let totalIncome = 0;
                    let totalExpense = 0;

                    if (transactionRows && transactionRows.length > 0) {
                        transactionRows.forEach(row => {
                            const total = parseFloat(row.total) || 0;
                            if (row.type === 'income') {
                                totalIncome = total;
                            } else if (row.type === 'expense') {
                                totalExpense = total;
                            }
                        });
                    }

                    const calculatedBalance = openingBalance + totalIncome - totalExpense;
                    const actualBal = parseFloat(actual_balance);
                    const difference = actualBal - calculatedBalance;

                    resolve({
                        previous_settlement_date: previousDate,
                        opening_balance: openingBalance,
                        total_income: totalIncome,
                        total_expense: totalExpense,
                        calculated_balance: calculatedBalance,
                        difference: difference
                    });
                });
            });
        });

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
router.delete('/:id', (req, res) => {
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
