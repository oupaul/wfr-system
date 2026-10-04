// 「哪些收支屬於哪個銀行帳戶」的唯一比對規則（資金預估週報與銀行帳戶即時餘額共用）。
//
// 收支記錄存的是文字（公司名稱／帳戶名稱／帳號），不是外鍵。規則是**嚴格比對**三項，
// 且空值（NULL 或空字串）視為相同：
//   - 公司名稱：與帳戶所屬公司名稱相同（帳戶沒有公司時，交易也必須沒有公司）
//   - 帳戶名稱：完全相同
//   - 帳號：與帳戶帳號相同（帳戶沒有帳號時，交易也必須沒有帳號）
// 這樣每一筆交易只會歸到一個帳戶，不會重複計入；公司或帳號欄位對不上的交易不屬於任何帳戶，
// 可以用 scripts/find-unmatched-transactions.js 找出來補資料。

function norm(v) {
    return v === null || v === undefined ? '' : String(v);
}

// 記憶體內比對：t 是一筆交易（或範本），account 需有 company_name / account_name / account_number
function transactionBelongsToAccount(t, account) {
    return !!account.account_name
        && t.account_name === account.account_name
        && norm(t.company_name) === norm(account.company_name)
        && norm(t.account_number) === norm(account.account_number);
}

// SQL 版本（交易表別名自行傳入）；回傳 { sql, params }
function transactionAccountSql(account, alias = '') {
    const p = alias ? `${alias}.` : '';
    return {
        sql: `${p}account_name = ? AND IFNULL(${p}company_name, '') = ? AND IFNULL(${p}account_number, '') = ?`,
        params: [account.account_name, norm(account.company_name), norm(account.account_number)]
    };
}

module.exports = { norm, transactionBelongsToAccount, transactionAccountSql };
