const logger = require('./logger');

// 找某個帳戶最近一次的餘額結算記錄，當作即時餘額／資金預估的起算基準。
// 公司名稱＋帳戶名稱要精確比對；帳戶有填帳號時，容許結算記錄沒填帳號（NULL，相容舊資料）。
// 不會 fallback 到「未指定帳戶」的公司層級結算——那種結算只是過渡用法，
// 不該被拿來當某個帳戶的起算基準（跟使用者確認過，2026-10）。
//
// 原本 utils/bankAccountBalance.js 跟 routes/cashGap.js 各自寫了一套比對邏輯，
// 規則不一致，會讓「銀行帳戶管理」的即時餘額跟「資金預估週報」算出不同數字，
// 這裡統一成單一函式，兩邊都呼叫同一套。
function getLatestSettlement(db, { companyName, accountName, accountNumber }) {
    return new Promise((resolve, reject) => {
        if (!accountName) return resolve(null);

        let where = companyName ? 'company_name = ? AND account_name = ?' : 'account_name = ?';
        const params = companyName ? [companyName, accountName] : [accountName];
        if (accountNumber) {
            where += ' AND (account_number = ? OR account_number IS NULL)';
            params.push(accountNumber);
        }

        db.get(
            `SELECT settlement_date, actual_balance FROM balance_settlements WHERE ${where} ORDER BY settlement_date DESC LIMIT 1`,
            params,
            (err, row) => {
                if (err) {
                    logger.error('查詢餘額結算錯誤:', err);
                    return reject(err);
                }
                resolve(row || null);
            }
        );
    });
}

// 一次查詢取回多個帳戶各自「最近一次結算」，比對規則跟上面 getLatestSettlement 完全一致，
// 只是改成一次撈出相關帳戶名稱的所有結算、在記憶體裡依帳戶挑選，避免每個帳戶各查一次。
// 同一天有多筆結算時取 id 較小（較早建立）的那一筆，跟上面單筆查詢（ORDER BY settlement_date DESC LIMIT 1）
// 實際回傳的結果一致，確保批次與單筆兩種算法算出同一個起算基準。
// accounts: [{ id, company_name, account_name, account_number }]；回傳 Map<account.id, 結算列|null>
async function getLatestSettlementsForAccounts(db, accounts) {
    const result = new Map();
    const names = [...new Set(accounts.map((a) => a.account_name).filter(Boolean))];
    accounts.forEach((a) => result.set(a.id, null));
    if (names.length === 0) return result;

    const rows = await new Promise((resolve, reject) => {
        db.all(
            `SELECT settlement_date, company_name, account_name, account_number, actual_balance
             FROM balance_settlements
             WHERE account_name IN (${names.map(() => '?').join(',')})
             ORDER BY settlement_date DESC, id ASC`,
            names,
            (err, r) => (err ? reject(err) : resolve(r || []))
        );
    });

    accounts.forEach((a) => {
        if (!a.account_name) return;
        const companyName = a.company_name || null;
        const accountNumber = a.account_number || null;
        const match = rows.find((r) =>
            r.account_name === a.account_name
            && (!companyName || r.company_name === companyName)
            && (!accountNumber || r.account_number === accountNumber || r.account_number == null)
        );
        result.set(a.id, match || null);
    });
    return result;
}

module.exports = { getLatestSettlement, getLatestSettlementsForAccounts };
