const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getProjectedRepaymentRowsByAccount } = require('../utils/financingProjection');
const { getProjectedTemplateRowsByAccount } = require('../utils/templateProjection');
const { getLatestSettlementsForAccounts } = require('../utils/settlementLookup');
const { requireEditor } = require('../middleware/auth');
const { writeOperationLog } = require('../utils/operationLog');
const { todayInTaipei, addDaysStr } = require('../utils/dateUtil');
const { transactionBelongsToAccount } = require('../utils/accountMatch');
const { DEFAULT_CHECK_DAYS, getAccountCheckDays, buildCheckDates } = require('../utils/checkDays');

// ==================== 批次載入（避免每個帳戶各查好幾次資料庫） ====================
// 原本每個端點都對「每個帳戶」各查一次結算、一次交易、一次借款、一次範本（N+1），
// 帳戶越多查詢次數線性成長；現在整批各只查一次，再在記憶體裡依帳戶分配，
// 比對規則（公司/帳戶名稱/帳號、結算日期起算）跟原本逐帳戶查詢完全一致。

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function loadActiveAccounts(extraWhere = '', params = []) {
    return dbAll(`
        SELECT ba.*, c.name as company_name, c.check_days as company_check_days
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE ba.is_active = 1 ${extraWhere}
        ORDER BY c.name, ba.account_name
    `, params);
}

// 回傳 Map<account.id, { settlement, openingBalance, startDate, rows }>
// rows：該帳戶從最近一次結算日起到 endDate 為止的真實交易（依日期、id 排序）。
// 查詢失敗只記錄錯誤、當作沒有資料繼續（跟原本逐帳戶查詢時的容錯行為一致）。
async function loadAccountInputs(accounts, endDate) {
    let settlements = new Map();
    try {
        settlements = await getLatestSettlementsForAccounts(db, accounts);
    } catch (err) {
        logger.error('查詢結算記錄錯誤:', err);
    }

    const infos = new Map();
    let minStart = null;
    accounts.forEach((account) => {
        const settlement = settlements.get(account.id) || null;
        const info = {
            settlement,
            openingBalance: settlement ? parseFloat(settlement.actual_balance) : 0,
            startDate: settlement ? settlement.settlement_date : '2000-01-01',
            rows: []
        };
        infos.set(account.id, info);
        if (minStart === null || info.startDate < minStart) minStart = info.startDate;
    });

    const names = [...new Set(accounts.map((a) => a.account_name).filter(Boolean))];
    if (names.length === 0) return infos;

    try {
        const txRows = await dbAll(`
            SELECT transaction_date, type, amount, description, company_name, account_name, account_number
            FROM transactions
            WHERE account_name IN (${names.map(() => '?').join(',')})
              AND transaction_date >= ? AND transaction_date <= ?
            ORDER BY transaction_date, id
        `, [...names, minStart, endDate]);

        const byName = new Map();
        txRows.forEach((t) => {
            if (!byName.has(t.account_name)) byName.set(t.account_name, []);
            byName.get(t.account_name).push(t);
        });
        accounts.forEach((account) => {
            if (!account.account_name) return;
            const info = infos.get(account.id);
            info.rows = (byName.get(account.account_name) || []).filter((t) =>
                transactionBelongsToAccount(t, account) && t.transaction_date >= info.startDate
            );
        });
    } catch (err) {
        logger.error('查詢交易錯誤:', err);
    }
    return infos;
}

// 借款還款投影 + 週期範本投影，一起併入未來預測；回傳 Map<account.id, 預計事件[]>
async function loadProjectedFutureRows(accounts, today, maxDate) {
    const [repayments, templates] = await Promise.all([
        getProjectedRepaymentRowsByAccount(db, accounts.map((a) => a.id), today, maxDate),
        getProjectedTemplateRowsByAccount(db, accounts, today, maxDate)
    ]);
    const result = new Map();
    accounts.forEach((a) => result.set(a.id, (repayments.get(a.id) || []).concat(templates.get(a.id) || [])));
    return result;
}

function sendQueryError(res, logMessage, err) {
    logger.error(logMessage, err);
    res.status(500).json({ error: '查詢失敗', details: err.message });
}

// 每個帳戶的結餘檢查日由所屬公司設定（預設每月 15、30 號，見 utils/checkDays.js）。
// monthsAhead：資金缺口卡片、對帳 API 用 3（近三個月），資金流水帳用 12（未來一整年）。
// 回傳 perAccount: Map<account.id, 該帳戶的檢查日[]>、targetDates: 所有帳戶檢查日的聯集（排序）
function planCheckDates(accounts, monthsAhead, today) {
    const perAccount = new Map();
    const union = new Set();
    accounts.forEach((a) => {
        const dates = buildCheckDates(getAccountCheckDays(a), monthsAhead, today);
        perAccount.set(a.id, dates);
        dates.forEach((d) => union.add(d));
    });
    const targetDates = accounts.length === 0
        ? buildCheckDates(DEFAULT_CHECK_DAYS, monthsAhead, today)
        : Array.from(union).sort();
    return { perAccount, targetDates };
}

// 資金預估週報儀表板
router.get('/cash-gap-dashboard', async (req, res) => {
    const { forecastDays = 28 } = req.query;
    const today = todayInTaipei();
    const forecastEndDate = addDaysStr(today, parseInt(forecastDays));

    try {
        const accounts = await loadActiveAccounts();
        if (accounts.length === 0) {
            return res.json({ data: [], summary: { totalAccounts: 0, totalBalance: 0, gapAccounts: 0, nearestGapDate: null, totalGap: 0, currentDate: today } });
        }
        const inputs = await loadAccountInputs(accounts, forecastEndDate);

        const dashboardData = accounts.map((account) => {
            const { settlement, openingBalance, rows } = inputs.get(account.id);

            let pastIncome = 0;
            let pastExpense = 0;
            let futureIncome = 0;
            let futureExpense = 0;
            rows.forEach((t) => {
                const amt = parseFloat(t.amount) || 0;
                const isIncome = t.type === 'income';
                if (t.transaction_date <= today) {
                    if (isIncome) pastIncome += amt; else pastExpense += amt;
                }
                if (t.transaction_date >= today) {
                    if (isIncome) futureIncome += amt; else futureExpense += amt;
                }
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
                                gapDate = addDaysStr(today, daysToGap);
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

            return {
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
            };
        });

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
    } catch (err) {
        sendQueryError(res, '資金預估週報儀表板錯誤:', err);
    }
});

// 資金缺口：未來三個月，各帳戶依所屬公司設定的檢查日（預設每月 15 號、30 號）
router.get('/cash-gap-dashboard-by-dates', async (req, res) => {
    const today = todayInTaipei();

    try {
        const accounts = await loadActiveAccounts();
        const { perAccount, targetDates } = planCheckDates(accounts, 3, today);
        const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;
        if (accounts.length === 0) {
            return res.json({
                targetDates: targetDates,
                data: [],
                summary: { totalBalance: 0, totalGapByDate: {} }
            });
        }
        const [inputs, projections] = await Promise.all([
            loadAccountInputs(accounts, maxDate),
            loadProjectedFutureRows(accounts, today, maxDate)
        ]);

        const dashboardData = accounts.map((account) => {
            const { settlement, openingBalance, rows } = inputs.get(account.id);
            const safetyLevel = parseFloat(account.safety_level) || 0;
            const projectedRows = projections.get(account.id) || [];

            // 「未來預測」的檢查點才併入借款投影；current_balance/
            // transaction_count 維持只用真實交易，確保「目前」的數字
            // 永遠是真實資料
            const allRows = rows.concat(projectedRows);
            const byDate = perAccount.get(account.id).map((dateStr) => {
                let income = 0, expense = 0;
                allRows.forEach((r) => {
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
            rows.forEach((r) => {
                if (r.transaction_date > today) return;
                const amt = parseFloat(r.amount) || 0;
                if (r.type === 'income') currentBalance += amt;
                else currentBalance -= amt;
            });

            return {
                account_id: account.id,
                company_name: account.company_name || '',
                account_name: account.account_name || '',
                account_number: account.account_number || '',
                account_type: account.account_type || '',
                bank_name: account.bank_name || '',
                opening_balance: openingBalance,
                current_balance: currentBalance,
                safety_level: safetyLevel,
                last_settlement_date: settlement?.settlement_date || null,
                transaction_count: rows.length,
                by_date: byDate
            };
        });

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
    } catch (err) {
        sendQueryError(res, '各檢查日預計餘額錯誤:', err);
    }
});

// 資金流水帳檢視：帳戶為欄、逐筆交易與結餘檢查點為列。
// 檢查日由各公司自訂（預設每月 15/30 號）：某天的結餘列只顯示「該天是檢查日的公司」的帳戶，
// 其他公司的欄位留白；只有部分公司適用時，列的標題會註明是哪些公司。
router.get('/cash-gap-ledger', async (req, res) => {
    const today = todayInTaipei();

    try {
        const accounts = await loadActiveAccounts();
        const { perAccount, targetDates } = planCheckDates(accounts, 12, today);
        const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;
        if (accounts.length === 0) {
            return res.json({ targetDates, columns: [], rows: [] });
        }
        const accountById = new Map(accounts.map((a) => [a.id, a]));
        const allCompanyNames = new Set(accounts.map((a) => a.company_name || '未分類'));
        const [inputs, projections] = await Promise.all([
            loadAccountInputs(accounts, maxDate),
            loadProjectedFutureRows(accounts, today, maxDate)
        ]);

        const columns = [];
        const accountFutureTxns = {};
        accounts.forEach((account) => {
            const { openingBalance, rows } = inputs.get(account.id);

            let currentBalance = openingBalance;
            rows.forEach((r) => {
                if (r.transaction_date > today) return;
                const amt = parseFloat(r.amount) || 0;
                currentBalance += (r.type === 'income' ? amt : -amt);
            });

            columns.push({
                account_id: account.id,
                company_name: account.company_name || '',
                account_name: account.account_name || '',
                account_number: account.account_number || '',
                account_type: account.account_type || '',
                bank_name: account.bank_name || '',
                opening_balance: openingBalance,
                current_balance: currentBalance
            });
            // 真實未來交易 + 借款投影還款 + 週期範本投影合併成同一份「未來事件」清單，
            // 下面的 eventDateSet 建立與逐日累加餘額邏輯對三者一視同仁
            accountFutureTxns[account.id] = rows
                .filter((r) => r.transaction_date > today)
                .concat(projections.get(account.id) || []);
        });

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
                            amount: amt,
                            is_projected: !!t.is_projected
                        });
                    });
            });

            if (targetDates.includes(dateStr)) {
                const balancesSnapshot = {};
                const companiesHere = new Set();
                columns.forEach((c) => {
                    if (!perAccount.get(c.account_id).includes(dateStr)) return;
                    balancesSnapshot[c.account_id] = running[c.account_id];
                    companiesHere.add(accountById.get(c.account_id).company_name || '未分類');
                });
                const label = companiesHere.size === allCompanyNames.size
                    ? '資金餘額'
                    : `資金餘額（${Array.from(companiesHere).join('、')}）`;
                rowsOut.push({ type: 'balance', date: dateStr, label, balances: balancesSnapshot });
            }
        });

        // 帳戶餘額在整段檢視期間都是 0（沒有結算金額也沒有任何交易）就不顯示，減少表格雜訊
        const balanceRows = rowsOut.filter((r) => r.type === 'balance');
        const zeroAccountIds = new Set(
            columns
                .filter((c) => balanceRows.every((r) => (r.balances[c.account_id] || 0) === 0))
                .map((c) => c.account_id)
        );
        const visibleColumns = columns.filter((c) => !zeroAccountIds.has(c.account_id));
        const visibleRows = rowsOut
            .filter((r) => r.type !== 'transaction' || !zeroAccountIds.has(r.account_id))
            .map((r) => {
                if (r.type !== 'balance') return r;
                const balances = { ...r.balances };
                zeroAccountIds.forEach((id) => delete balances[id]);
                return { ...r, balances };
            });

        res.json({ targetDates, columns: visibleColumns, rows: visibleRows });
    } catch (err) {
        sendQueryError(res, '資金流水帳錯誤:', err);
    }
});

// 資金缺口對帳 API
router.get('/cash-gap-reconciliation', async (req, res) => {
    const company = (req.query.company || '').trim();
    const account = (req.query.account || '').trim();
    const today = todayInTaipei();

    try {
        const accounts = await loadActiveAccounts(
            `AND (? = '' OR c.name = ? OR c.name LIKE ?)
             AND (? = '' OR ba.account_name = ? OR ba.account_name LIKE ?)`,
            [company, company, company ? `%${company}%` : '%', account, account, account ? `%${account}%` : '%']
        );
        const { perAccount, targetDates } = planCheckDates(accounts, 3, today);
        const maxDate = targetDates.length ? targetDates[targetDates.length - 1] : today;
        if (accounts.length === 0) {
            return res.json({
                targetDates,
                currentDate: today,
                data: [],
                note: '系統計算：預計餘額 = 期初餘額 + 收入合計 - 支出合計；資金缺口 = 安全水位 - 預計餘額（若預計餘額 < 安全水位）。期初餘額來自「結算」功能，請確認與 Excel 的期初一致。'
            });
        }
        const inputs = await loadAccountInputs(accounts, maxDate);

        const result = accounts.map((acc) => {
            const { settlement, openingBalance, rows } = inputs.get(acc.id);
            const safetyLevel = parseFloat(acc.safety_level) || 0;
            const byDate = perAccount.get(acc.id).map((dateStr) => {
                let income = 0, expense = 0;
                rows.forEach((r) => {
                    if (r.transaction_date > dateStr) return;
                    const amt = parseFloat(r.amount) || 0;
                    if (r.type === 'income') income += amt;
                    else expense += amt;
                });
                const projectedBalance = openingBalance + income - expense;
                const gap = projectedBalance < safetyLevel ? safetyLevel - projectedBalance : 0;
                return { date: dateStr, income_sum: income, expense_sum: expense, projected_balance: projectedBalance, gap };
            });
            return {
                account_id: acc.id,
                company_name: acc.company_name || '',
                account_name: acc.account_name || '',
                account_number: acc.account_number || '',
                opening_balance: openingBalance,
                settlement_date: settlement?.settlement_date || null,
                safety_level: safetyLevel,
                transaction_count: rows.length,
                by_date: byDate
            };
        });

        res.json({
            targetDates,
            currentDate: today,
            data: result,
            note: '預計餘額 = 期初餘額 + 收入合計 - 支出合計。資金缺口 = 安全水位 - 預計餘額（當預計餘額 < 安全水位）。請確認 Excel 的期初餘額與系統「結算」一致，且公司/帳戶/帳號與系統完全一致。'
        });
    } catch (err) {
        sendQueryError(res, '資金缺口對帳錯誤:', err);
    }
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

// 資金流水帳上方「目前貸款餘額」：由財務人員手動填寫，存在 system_settings（所有使用者看到同一個數字）
const LOAN_BALANCE_KEY = 'cash_gap_manual_loan_balance';

router.get('/cash-gap-loan-balance', (req, res) => {
    db.get('SELECT value, updated_at FROM system_settings WHERE key = ?', [LOAN_BALANCE_KEY], (err, row) => {
        if (err) {
            logger.error('查詢貸款餘額錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        const amount = row && row.value !== '' && row.value != null ? parseFloat(row.value) : null;
        res.json({ amount, updated_at: row ? row.updated_at : null });
    });
});

router.put('/cash-gap-loan-balance', requireEditor, (req, res) => {
    const raw = req.body.amount;
    const isEmpty = raw === null || raw === undefined || raw === '';
    const amount = isEmpty ? null : Number(raw);
    if (!isEmpty && (!Number.isFinite(amount) || amount < 0)) {
        return res.status(400).json({ error: '貸款餘額必須是大於或等於 0 的數字' });
    }
    db.get('SELECT value FROM system_settings WHERE key = ?', [LOAN_BALANCE_KEY], (getErr, oldRow) => {
        if (getErr) {
            logger.error('查詢貸款餘額錯誤:', getErr);
            return res.status(500).json({ error: '儲存失敗', details: getErr.message });
        }
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [LOAN_BALANCE_KEY, isEmpty ? '' : String(amount), now],
            (err) => {
                if (err) {
                    logger.error('儲存貸款餘額錯誤:', err);
                    return res.status(500).json({ error: '儲存失敗', details: err.message });
                }
                writeOperationLog(req, 'update', 'system_settings', LOAN_BALANCE_KEY,
                    { amount: oldRow && oldRow.value !== '' ? parseFloat(oldRow.value) : null }, { amount },
                    '資金流水帳目前貸款餘額已更新');
                res.json({ success: true, amount, updated_at: now });
            }
        );
    });
});

module.exports = router;
