// 一次性遷移：結算的計算規則改成「實際餘額＝結算日當天開始前的餘額」（見 utils/settlementCalc.js）後，
// 既有結算記錄裡儲存的「期初餘額／期間收入／期間支出／計算餘額／差異」是舊規則算出來的，
// 這裡依新規則全部重算一次。實際餘額（使用者輸入的銀行餘額）完全不動，流水帳、即時餘額也不受影響
// （它們本來就用新規則），只是結算歷史表上的這幾個衍生欄位會更正。
// 用 system_settings 的旗標確保只跑一次。
const { db } = require('../database/db');
const logger = require('./logger');
const { calculateSettlement } = require('./settlementCalc');
const { writeOperationLog } = require('./operationLog');

const FLAG_KEY = 'settlement_calc_start_of_day_v1';

const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));
const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { return e ? reject(e) : resolve(this); }));

async function recalculateAllSettlementsOnce() {
    const done = await dbGet('SELECT value FROM system_settings WHERE key = ?', [FLAG_KEY]);
    if (done) return { skipped: true };

    const rows = await dbAll('SELECT * FROM balance_settlements ORDER BY settlement_date, id');
    let changed = 0;
    for (const row of rows) {
        const c = await calculateSettlement({
            settlement_date: row.settlement_date, company_name: row.company_name,
            account_name: row.account_name, account_number: row.account_number
        }, row.id);
        const difference = (parseFloat(row.actual_balance) || 0) - c.calculated_balance;
        const same = Math.abs((row.calculated_balance || 0) - c.calculated_balance) < 0.005
            && Math.abs((row.total_income || 0) - c.total_income) < 0.005
            && Math.abs((row.total_expense || 0) - c.total_expense) < 0.005
            && Math.abs((row.opening_balance || 0) - c.opening_balance) < 0.005
            && (row.previous_settlement_date || null) === (c.previous_settlement_date || null);
        if (same) continue;
        await dbRun(
            `UPDATE balance_settlements SET previous_settlement_date = ?, opening_balance = ?, total_income = ?, total_expense = ?,
             calculated_balance = ?, difference = ? WHERE id = ?`,
            [c.previous_settlement_date, c.opening_balance, c.total_income, c.total_expense, c.calculated_balance, difference, row.id]);
        changed++;
    }
    await dbRun(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)`, [FLAG_KEY, new Date().toISOString(), new Date().toISOString()]);
    logger.info(`結算計算規則遷移完成：共 ${rows.length} 筆結算，重算更正 ${changed} 筆`);
    if (changed > 0) {
        writeOperationLog(null, 'update', 'settlement_recalc', FLAG_KEY, null, { total: rows.length, changed },
            `結算計算規則改為「實際餘額＝結算日當天開始前」，重算 ${changed} 筆結算的期間收支、計算餘額與差異`);
    }
    return { total: rows.length, changed };
}

module.exports = { recalculateAllSettlementsOnce };
