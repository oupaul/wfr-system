// 資金預估週報與統計報表共用的資料載入（批次查詢，避免每個帳戶各查好幾次資料庫）
const { db } = require('../database/db');
const logger = require('./logger');
const { getProjectedRepaymentRowsByAccount } = require('./financingProjection');
const { getProjectedTemplateRowsByAccount } = require('./templateProjection');
const { getLatestSettlementsForAccounts } = require('./settlementLookup');
const { transactionBelongsToAccount } = require('./accountMatch');
const { projectDepositRows } = require('./deposit');

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

// 借款還款投影 + 週期範本投影 + 定存到期投影，一起併入未來預測；回傳 Map<account.id, 預計事件[]>
// inputsPromise：loadAccountInputs 的結果（Promise）。定存到期需要各帳戶的期初與交易來算到期日的本金，
// 讓借款、範本的查詢可以跟它並行，不用等它算完才開始。
async function loadProjectedFutureRows(accounts, today, maxDate, inputsPromise) {
    const [repayments, templates, inputs] = await Promise.all([
        getProjectedRepaymentRowsByAccount(db, accounts.map((a) => a.id), today, maxDate),
        getProjectedTemplateRowsByAccount(db, accounts, today, maxDate),
        inputsPromise
    ]);
    const deposits = projectDepositRows(accounts, inputs, today, maxDate);
    const result = new Map();
    accounts.forEach((a) => result.set(a.id, (repayments.get(a.id) || [])
        .concat(templates.get(a.id) || [])
        .concat(deposits.get(a.id) || [])));
    return result;
}

module.exports = { dbAll, loadActiveAccounts, loadAccountInputs, loadProjectedFutureRows };
