/**
 * 找出「不屬於任何啟用中銀行帳戶」的收支記錄（唯讀，不會修改任何資料）。
 *
 * 背景：收支記錄存的是文字（公司名稱／帳戶名稱／帳號）。資金預估週報與銀行帳戶的即時餘額
 * 共用同一套嚴格比對規則（utils/accountMatch.js）：三項都要與銀行帳戶相同，空值視為相同。
 * 公司或帳號欄位是空的、或與銀行帳戶對不上的收支，不會被算進任何帳戶的餘額。
 * 這個工具把它們列出來，並指出「最可能是哪個帳戶」與缺哪個欄位，方便到「收支記錄」補資料。
 *
 * 用法：node scripts/find-unmatched-transactions.js
 */
const { db, initDatabase, closeDatabase } = require('../database/db');
const { norm } = require('../utils/accountMatch');

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}

async function main() {
    await initDatabase();
    const accounts = await dbAll(
        `SELECT ba.id, ba.account_name, ba.account_number, c.name AS company_name
         FROM bank_accounts ba LEFT JOIN companies c ON ba.company_id = c.id
         WHERE ba.is_active = 1`
    );
    const txs = await dbAll(
        `SELECT id, transaction_date, type, amount, description, company_name, account_name, account_number
         FROM transactions WHERE account_name IS NOT NULL AND account_name <> ''
         ORDER BY transaction_date, id`
    );

    const unmatched = [];
    txs.forEach((t) => {
        const exact = accounts.some((a) => a.account_name === t.account_name
            && norm(a.company_name) === norm(t.company_name) && norm(a.account_number) === norm(t.account_number));
        if (exact) return;
        const sameName = accounts.filter((a) => a.account_name === t.account_name);
        let reason;
        if (sameName.length === 0) reason = '找不到同名的啟用中帳戶（帳戶名稱打錯、已改名或已停用）';
        else {
            const parts = [];
            if (!sameName.some((a) => norm(a.company_name) === norm(t.company_name))) parts.push(`公司「${norm(t.company_name) || '（空）'}」對不上`);
            if (!sameName.some((a) => norm(a.account_number) === norm(t.account_number))) parts.push(`帳號「${norm(t.account_number) || '（空）'}」對不上`);
            reason = (parts.join('、') || '公司與帳號組合對不上') + `；可能是：${sameName.map((a) => `${a.company_name || '（無公司）'}／${a.account_number || '（無帳號）'}`).join(' 或 ')}`;
        }
        unmatched.push({ t, reason });
    });

    console.log(`共檢查 ${txs.length} 筆有指定帳戶的收支記錄，其中 ${unmatched.length} 筆不屬於任何啟用中的銀行帳戶。`);
    unmatched.forEach(({ t, reason }) => {
        console.log(`#${t.id}  ${t.transaction_date}  ${t.type === 'income' ? '收入' : '支出'} ${t.amount}  ${t.description || ''}`
            + `\n     公司「${norm(t.company_name)}」 帳戶「${t.account_name}」 帳號「${norm(t.account_number)}」\n     → ${reason}`);
    });
    if (unmatched.length === 0) console.log('✓ 全部都能對上帳戶，不需要處理。');
    else console.log('\n請到「收支記錄」編輯這些記錄，用下拉選單重新選擇公司與帳戶後儲存；儲存後餘額會自動重算。');
    await closeDatabase();
}

main().catch((err) => { console.error(err); process.exit(1); });
