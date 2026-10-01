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

module.exports = { getLatestSettlement };
