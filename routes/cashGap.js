const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');

function toLocalDateStr(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

// 若該月天數不足（例如 2 月沒有 30 號），改用該月最後一天，避免日期滾動到下個月
function clampToMonth(year, month, day) {
    const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(day, lastDayOfMonth));
}

function buildMonthlyTargetDates() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const y = today.getFullYear();
    const m = today.getMonth();
    const out = [];
    for (let i = 0; i < 3; i++) {
        const d15 = clampToMonth(y, m + i, 15);
        const d30 = clampToMonth(y, m + i, 30);
        if (d15 >= today) out.push(toLocalDateStr(d15));
        if (d30 >= today) out.push(toLocalDateStr(d30));
    }
    return out.sort();
}

// 資金預估週報儀表板
router.get('/cash-gap-dashboard', (req, res) => {
    const { forecastDays = 28 } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const forecastEndDate = new Date(Date.now() + parseInt(forecastDays) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
        ORDER BY c.name, ba.account_name
    `, [], (err, accounts) => {
        if (err) {
            logger.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }

        const dashboardData = [];
        let processedCount = 0;

        if (accounts.length === 0) {
            return res.json({ data: [], summary: { totalAccounts: 0, totalBalance: 0, gapAccounts: 0, nearestGapDate: null, totalGap: 0, currentDate: today } });
        }

        accounts.forEach((account) => {
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                account.company_name || '',
                account.account_name || null,
                account.account_number || null,
                account.account_name || null,
                account.account_number || null,
                account.account_number || null
            ], (err, settlement) => {
                if (err) {
                    logger.error('查詢結算記錄錯誤:', err);
                }

                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';

                db.all(`
                    SELECT 
                        type,
                        SUM(CASE WHEN transaction_date >= ? AND transaction_date <= ? THEN amount ELSE 0 END) as future_amount,
                        COUNT(CASE WHEN transaction_date >= ? AND transaction_date <= ? THEN 1 ELSE NULL END) as future_count
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    GROUP BY type
                `, [today, forecastEndDate, today, forecastEndDate,
                    account.company_name || '', account.account_name || null, account.account_number || null, account.account_number || null,
                    startDate, forecastEndDate], (err, futureTransactions) => {
                    if (err) {
                        logger.error('查詢未來交易錯誤:', err);
                    }

                    db.all(`
                        SELECT 
                            type,
                            SUM(amount) as total_amount
                        FROM transactions
                        WHERE company_name = ?
                          AND account_name = ?
                          AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                          AND transaction_date >= ?
                          AND transaction_date <= ?
                        GROUP BY type
                    `, [account.company_name || '', account.account_name || null, account.account_number || null, account.account_number || null,
                        startDate, today], (err, pastTransactions) => {
                        if (err) {
                            logger.error('查詢過去交易錯誤:', err);
                        }

                        let pastIncome = 0;
                        let pastExpense = 0;
                        pastTransactions?.forEach(t => {
                            if (t.type === 'income') pastIncome += parseFloat(t.total_amount) || 0;
                            else pastExpense += parseFloat(t.total_amount) || 0;
                        });

                        let futureIncome = 0;
                        let futureExpense = 0;
                        futureTransactions?.forEach(t => {
                            if (t.type === 'income') futureIncome += parseFloat(t.future_amount) || 0;
                            else futureExpense += parseFloat(t.future_amount) || 0;
                        });

                        const currentBalance = openingBalance + pastIncome - pastExpense;
                        const projectedBalance = currentBalance + futureIncome - futureExpense;
                        const safetyLevel = parseFloat(account.safety_level) || 0;
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        const isGap = gap > 0;

                        let gapDate = null;
                        if (isGap) {
                            if (currentBalance < safetyLevel) {
                                gapDate = today;
                            } else {
                                const netCashFlow = futureIncome - futureExpense;
                                const daysToForecast = parseInt(forecastDays);

                                if (netCashFlow < 0 && daysToForecast > 0) {
                                    const dailyNetFlow = Math.abs(netCashFlow) / daysToForecast;
                                    const balanceBuffer = currentBalance - safetyLevel;
                                    if (dailyNetFlow > 0) {
                                        const daysToGap = Math.ceil(balanceBuffer / dailyNetFlow);
                                        if (daysToGap > 0 && daysToGap <= daysToForecast) {
                                            const gapDateObj = new Date(Date.now() + daysToGap * 24 * 60 * 60 * 1000);
                                            gapDate = gapDateObj.toISOString().split('T')[0];
                                        } else {
                                            gapDate = forecastEndDate;
                                        }
                                    } else {
                                        gapDate = forecastEndDate;
                                    }
                                } else {
                                    gapDate = forecastEndDate;
                                }
                            }
                        }

                        dashboardData.push({
                            account_id: account.id,
                            company_name: account.company_name || '',
                            account_name: account.account_name || '',
                            account_number: account.account_number || '',
                            opening_balance: openingBalance,
                            current_balance: currentBalance,
                            past_income: pastIncome,
                            past_expense: pastExpense,
                            future_income: futureIncome,
                            future_expense: futureExpense,
                            projected_balance: projectedBalance,
                            safety_level: safetyLevel,
                            gap: gap,
                            is_gap: isGap,
                            gap_date: gapDate,
                            last_settlement_date: settlement?.settlement_date || null
                        });

                        processedCount++;
                        if (processedCount === accounts.length) {
                            const gapAccounts = dashboardData.filter(d => d.is_gap);
                            const totalGap = dashboardData.reduce((sum, d) => sum + d.gap, 0);
                            const totalBalance = dashboardData.reduce((sum, d) => sum + (d.current_balance || 0), 0);

                            let nearestGapDate = null;
                            if (gapAccounts.length > 0) {
                                const gapDates = gapAccounts
                                    .map(d => d.gap_date)
                                    .filter(date => date !== null)
                                    .sort();
                                if (gapDates.length > 0) {
                                    nearestGapDate = gapDates[0];
                                }
                            }

                            res.json({
                                data: dashboardData,
                                summary: {
                                    totalAccounts: accounts.length,
                                    totalBalance: totalBalance,
                                    gapAccounts: gapAccounts.length,
                                    nearestGapDate: nearestGapDate,
                                    totalGap: totalGap,
                                    forecastDays: parseInt(forecastDays),
                                    forecastEndDate: forecastEndDate,
                                    currentDate: today
                                }
                            });
                        }
                    });
                });
            });
        });
    });
});

// 資金缺口：未來三個月每月 15 號、30 號
router.get('/cash-gap-dashboard-by-dates', (req, res) => {
    const now = new Date();
    const today = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const targetDates = buildMonthlyTargetDates();
    const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;

    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
        ORDER BY c.name, ba.account_name
    `, [], (err, accounts) => {
        if (err) {
            logger.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (accounts.length === 0) {
            return res.json({
                targetDates: targetDates,
                data: [],
                summary: { totalBalance: 0, totalGapByDate: {} }
            });
        }

        const dashboardData = [];
        let processedCount = 0;

        accounts.forEach((account) => {
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                account.company_name || '',
                account.account_name || null,
                account.account_number || null,
                account.account_name || null,
                account.account_number || null,
                account.account_number || null
            ], (err, settlement) => {
                if (err) {
                    logger.error('查詢結算記錄錯誤:', err);
                }
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';

                db.all(`
                    SELECT transaction_date, type, amount
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    ORDER BY transaction_date
                `, [
                    account.company_name || '',
                    account.account_name || null,
                    account.account_number || null,
                    account.account_number || null,
                    startDate,
                    maxDate
                ], (err, rows) => {
                    if (err) {
                        logger.error('查詢交易錯誤:', err);
                    }
                    const safetyLevel = parseFloat(account.safety_level) || 0;
                    const byDate = targetDates.map((dateStr) => {
                        let income = 0, expense = 0;
                        (rows || []).forEach((r) => {
                            if (r.transaction_date > dateStr) return;
                            const amt = parseFloat(r.amount) || 0;
                            if (r.type === 'income') income += amt;
                            else expense += amt;
                        });
                        const projectedBalance = openingBalance + income - expense;
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        return { date: dateStr, income_sum: income, expense_sum: expense, projected_balance: projectedBalance, gap };
                    });
                    let currentBalance = openingBalance;
                    (rows || []).forEach((r) => {
                        if (r.transaction_date > today) return;
                        const amt = parseFloat(r.amount) || 0;
                        if (r.type === 'income') currentBalance += amt;
                        else currentBalance -= amt;
                    });

                    dashboardData.push({
                        account_id: account.id,
                        company_name: account.company_name || '',
                        account_name: account.account_name || '',
                        account_number: account.account_number || '',
                        opening_balance: openingBalance,
                        current_balance: currentBalance,
                        safety_level: safetyLevel,
                        last_settlement_date: settlement?.settlement_date || null,
                        transaction_count: (rows || []).length,
                        by_date: byDate
                    });

                    processedCount++;
                    if (processedCount === accounts.length) {
                        const totalBalance = dashboardData.reduce((s, d) => s + (d.current_balance || 0), 0);
                        const totalGapByDate = {};
                        targetDates.forEach((d) => {
                            totalGapByDate[d] = dashboardData.reduce((s, a) => s + (a.by_date.find((x) => x.date === d)?.gap || 0), 0);
                        });
                        res.json({
                            targetDates,
                            data: dashboardData,
                            summary: {
                                totalBalance,
                                totalGapByDate,
                                currentDate: today
                            }
                        });
                    }
                });
            });
        });
    });
});

// 資金流水帳檢視：帳戶為欄、逐筆交易與每月 15/30 號結餘檢查點為列
router.get('/cash-gap-ledger', (req, res) => {
    const now = new Date();
    const today = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const targetDates = buildMonthlyTargetDates();
    const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;

    db.all(`
        SELECT ba.*, c.name as company_name
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
        ORDER BY c.name, ba.account_name
    `, [], (err, accounts) => {
        if (err) {
            logger.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (accounts.length === 0) {
            return res.json({ targetDates, columns: [], rows: [] });
        }

        const columns = [];
        const accountFutureTxns = {};
        let processedCount = 0;

        accounts.forEach((account) => {
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ?
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                account.company_name || '', account.account_name || null, account.account_number || null,
                account.account_name || null, account.account_number || null, account.account_number || null
            ], (err, settlement) => {
                if (err) {
                    logger.error('查詢結算記錄錯誤:', err);
                }
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';

                db.all(`
                    SELECT transaction_date, type, amount, description
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    ORDER BY transaction_date, id
                `, [
                    account.company_name || '', account.account_name || null, account.account_number || null, account.account_number || null,
                    startDate, maxDate
                ], (err, rows) => {
                    if (err) {
                        logger.error('查詢交易錯誤:', err);
                    }

                    let currentBalance = openingBalance;
                    (rows || []).forEach((r) => {
                        if (r.transaction_date > today) return;
                        const amt = parseFloat(r.amount) || 0;
                        currentBalance += (r.type === 'income' ? amt : -amt);
                    });

                    columns.push({
                        account_id: account.id,
                        company_name: account.company_name || '',
                        account_name: account.account_name || '',
                        account_type: account.account_type || '',
                        opening_balance: openingBalance,
                        current_balance: currentBalance
                    });
                    accountFutureTxns[account.id] = (rows || []).filter((r) => r.transaction_date > today);

                    processedCount++;
                    if (processedCount === accounts.length) {
                        // 還原成查詢時的帳戶順序（各帳戶的非同步查詢完成順序不保證一致）
                        columns.sort((a, b) =>
                            accounts.findIndex((x) => x.id === a.account_id) - accounts.findIndex((x) => x.id === b.account_id)
                        );

                        const rowsOut = [];

                        const balancesToday = {};
                        columns.forEach((c) => { balancesToday[c.account_id] = c.current_balance; });
                        rowsOut.push({ type: 'balance', date: today, label: '資金餘額', balances: balancesToday });

                        const eventDateSet = new Set(targetDates.filter((d) => d > today));
                        columns.forEach((c) => {
                            accountFutureTxns[c.account_id].forEach((t) => eventDateSet.add(t.transaction_date));
                        });
                        const eventDates = Array.from(eventDateSet).sort();

                        const running = {};
                        columns.forEach((c) => { running[c.account_id] = c.current_balance; });

                        eventDates.forEach((dateStr) => {
                            columns.forEach((c) => {
                                accountFutureTxns[c.account_id]
                                    .filter((t) => t.transaction_date === dateStr)
                                    .forEach((t) => {
                                        const amt = parseFloat(t.amount) || 0;
                                        running[c.account_id] += (t.type === 'income' ? amt : -amt);
                                        rowsOut.push({
                                            type: 'transaction',
                                            date: dateStr,
                                            account_id: c.account_id,
                                            description: t.description || '',
                                            txn_type: t.type,
                                            amount: amt
                                        });
                                    });
                            });

                            if (targetDates.includes(dateStr)) {
                                const balancesSnapshot = {};
                                columns.forEach((c) => { balancesSnapshot[c.account_id] = running[c.account_id]; });
                                rowsOut.push({ type: 'balance', date: dateStr, label: '資金餘額', balances: balancesSnapshot });
                            }
                        });

                        res.json({ targetDates, columns, rows: rowsOut });
                    }
                });
            });
        });
    });
});

// 資金缺口對帳 API
router.get('/cash-gap-reconciliation', (req, res) => {
    const company = (req.query.company || '').trim();
    const account = (req.query.account || '').trim();
    const now = new Date();
    const today = toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const targetDates = buildMonthlyTargetDates();
    const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;

    db.all(`
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1
          AND (? = '' OR c.name = ? OR c.name LIKE ?)
          AND (? = '' OR ba.account_name = ? OR ba.account_name LIKE ?)
        ORDER BY c.name, ba.account_name
    `, [company, company, company ? `%${company}%` : '%', account, account, account ? `%${account}%` : '%'], (err, accounts) => {
        if (err) {
            logger.error('查詢帳戶錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (accounts.length === 0) {
            return res.json({
                targetDates,
                currentDate: today,
                data: [],
                note: '系統計算：預計餘額 = 期初餘額 + 收入合計 - 支出合計；資金缺口 = 安全水位 - 預計餘額（若預計餘額 < 安全水位）。期初餘額來自「結算」功能，請確認與 Excel 的期初一致。'
            });
        }

        const result = [];
        let done = 0;
        accounts.forEach((acc) => {
            db.get(`
                SELECT actual_balance, settlement_date
                FROM balance_settlements
                WHERE company_name = ? 
                  AND (account_name = ? OR account_name IS NULL)
                  AND (account_number = ? OR account_number IS NULL)
                ORDER BY (CASE WHEN account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL)) THEN 0 ELSE 1 END), settlement_date DESC
                LIMIT 1
            `, [
                acc.company_name || '', acc.account_name || null, acc.account_number || null,
                acc.account_name || null, acc.account_number || null, acc.account_number || null
            ], (err, settlement) => {
                const openingBalance = settlement ? parseFloat(settlement.actual_balance) : 0;
                const startDate = settlement ? settlement.settlement_date : '2000-01-01';
                db.all(`
                    SELECT transaction_date, type, amount
                    FROM transactions
                    WHERE company_name = ?
                      AND account_name = ?
                      AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                      AND transaction_date >= ?
                      AND transaction_date <= ?
                    ORDER BY transaction_date
                `, [
                    acc.company_name || '', acc.account_name || null, acc.account_number || null, acc.account_number || null,
                    startDate, maxDate
                ], (err, rows) => {
                    if (err) {
                        done++;
                        if (done === accounts.length) res.json({ targetDates, currentDate: today, data: result });
                        return;
                    }
                    const safetyLevel = parseFloat(acc.safety_level) || 0;
                    const byDate = targetDates.map((dateStr) => {
                        let income = 0, expense = 0;
                        (rows || []).forEach((r) => {
                            if (r.transaction_date > dateStr) return;
                            const amt = parseFloat(r.amount) || 0;
                            if (r.type === 'income') income += amt;
                            else expense += amt;
                        });
                        const projectedBalance = openingBalance + income - expense;
                        const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                        return { date: dateStr, income_sum: income, expense_sum: expense, projected_balance: projectedBalance, gap };
                    });
                    result.push({
                        account_id: acc.id,
                        company_name: acc.company_name || '',
                        account_name: acc.account_name || '',
                        account_number: acc.account_number || '',
                        opening_balance: openingBalance,
                        settlement_date: settlement?.settlement_date || null,
                        safety_level: safetyLevel,
                        transaction_count: (rows || []).length,
                        by_date: byDate
                    });
                    done++;
                    if (done === accounts.length) {
                        res.json({
                            targetDates,
                            currentDate: today,
                            data: result,
                            note: '預計餘額 = 期初餘額 + 收入合計 - 支出合計。資金缺口 = 安全水位 - 預計餘額（當預計餘額 < 安全水位）。請確認 Excel 的期初餘額與系統「結算」一致，且公司/帳戶/帳號與系統完全一致。'
                        });
                    }
                });
            });
        });
    });
});

// 取得匯入記錄
router.get('/import-logs', (req, res) => {
    const limit = req.query.limit || 20;

    db.all(
        'SELECT * FROM import_logs ORDER BY imported_at DESC LIMIT ?',
        [limit],
        (err, rows) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            res.json({ data: rows });
        }
    );
});

module.exports = router;
