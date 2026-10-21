// 餘額結算的「計算餘額」：跟資金流水帳、銀行帳戶即時餘額使用同一套起算規則。
//
// 規則（全站統一）：結算記錄的「實際餘額」是**結算日當天開始前**的餘額（＝前一天收盤）。
// 結算日當天的收支不含在這次結算裡，而是計入結算之後的餘額（流水帳、即時餘額都是從結算日當天起往後加）。
// 所以某次結算（日期 D）相對於上一次結算（日期 P）：
//     計算餘額 = 上一次實際餘額 ＋ 日期在 [P, D−1] 的收入 － 支出
// 差異 = 這次實際餘額 − 計算餘額。
//
// 之前結算頁用「(P, D]」（含結算日當天、不含上一次結算日），跟流水帳的規則相反：
// 同一天有收支時，結算頁與流水帳會對同一筆收支算出不同的餘額，差異欄就會失真。
const { db } = require('../database/db');
const { transactionAccountSql } = require('./accountMatch');
const { addDaysStr } = require('./dateUtil');

const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));

// 結算記錄的帳戶文字（公司/帳戶/帳號）對應到實際的銀行帳戶，取帳戶本身的公司與帳號當作收支歸戶的依據
// （跟週報一致：結算可以沒填帳號，但收支一定要跟銀行帳戶完全相符）。找不到唯一的帳戶就用結算記錄自己的文字。
async function resolveIdentity({ company_name, account_name, account_number }) {
    let sql = `SELECT ba.account_number, c.name AS company_name FROM bank_accounts ba
               LEFT JOIN companies c ON c.id = ba.company_id
               WHERE ba.account_name = ? AND IFNULL(c.name, '') = ?`;
    const params = [account_name, company_name || ''];
    if (account_number) { sql += ' AND ba.account_number = ?'; params.push(account_number); }
    const rows = await dbAll(sql, params);
    if (rows.length === 1) return { company_name: rows[0].company_name || null, account_name, account_number: rows[0].account_number || null };
    return { company_name: company_name || null, account_name, account_number: account_number || null };
}

/**
 * @param input { settlement_date, company_name, account_name?, account_number? }
 * @param excludeId 編輯既有結算時排除自己
 * @returns { previous_settlement_date, opening_balance, total_income, total_expense, calculated_balance,
 *            period_start, period_end, same_day: { count, income, expense } }
 */
async function calculateSettlement(input, excludeId = null) {
    const { settlement_date, company_name, account_name } = input;
    const identity = account_name ? await resolveIdentity(input) : null;

    // 上一次結算：同一個帳戶、日期早於這次（不是「最新的一筆」，補登較早的結算才不會拿到比它晚的結算當期初）
    let prevSql, prevParams;
    if (identity) {
        prevSql = `SELECT * FROM balance_settlements WHERE company_name = ? AND account_name = ? AND settlement_date < ?`;
        prevParams = [company_name, account_name, settlement_date];
        if (identity.account_number) { prevSql += ' AND (account_number = ? OR account_number IS NULL)'; prevParams.push(identity.account_number); }
    } else {
        prevSql = `SELECT * FROM balance_settlements WHERE company_name = ? AND settlement_date < ?`; // 公司層級結算（沒選帳戶）
        prevParams = [company_name, settlement_date];
    }
    if (excludeId) { prevSql += ' AND id != ?'; prevParams.push(excludeId); }
    prevSql += ' ORDER BY settlement_date DESC, id ASC LIMIT 1';
    const prev = await dbGet(prevSql, prevParams);

    const previousDate = prev ? prev.settlement_date : null;
    const openingBalance = prev ? parseFloat(prev.actual_balance) || 0 : 0;
    const fromDate = previousDate || '1900-01-01';

    const match = identity ? transactionAccountSql(identity) : { sql: 'company_name = ?', params: [company_name] };
    const sumRows = (from, toExclusive) => dbAll(
        `SELECT type, SUM(amount) AS total, COUNT(*) AS cnt FROM transactions
         WHERE ${match.sql} AND transaction_date >= ? AND transaction_date < ? GROUP BY type`,
        [...match.params, from, toExclusive]);
    const fold = (rows) => rows.reduce((acc, r) => {
        const v = parseFloat(r.total) || 0;
        if (r.type === 'income') acc.income += v; else acc.expense += v;
        acc.count += r.cnt;
        return acc;
    }, { income: 0, expense: 0, count: 0 });

    const period = fold(await sumRows(fromDate, settlement_date)); // [上一次結算日, 結算日前一天]
    const sameDay = fold(await sumRows(settlement_date, addDaysStr(settlement_date, 1))); // 結算日當天

    return {
        previous_settlement_date: previousDate,
        opening_balance: openingBalance,
        total_income: period.income,
        total_expense: period.expense,
        calculated_balance: openingBalance + period.income - period.expense,
        period_start: previousDate || '無',
        period_end: addDaysStr(settlement_date, -1),
        same_day: { count: sameDay.count, income: sameDay.income, expense: sameDay.expense }
    };
}

module.exports = { calculateSettlement, resolveIdentity };
