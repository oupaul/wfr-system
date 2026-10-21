/**
 * 找出「公司＋帳戶名稱＋帳號」完全相同的啟用中銀行帳戶（唯讀，不會修改任何資料）。
 *
 * 系統用這三項把收支與結算記錄歸到帳戶，兩個帳戶身分相同時無法區分：交易會同時算進兩個帳戶
 * （資金預估週報的可用資金被重複計入）、轉帳的兩腿可能互相抵銷、即時餘額只會更新其中一個。
 * 常見成因：同一個銀行帳號底下的活存與定存，帳戶名稱也填一樣。
 *
 * 用法：node scripts/find-duplicate-accounts.js
 * 處理：把其中一個改名後，用 scripts/split-duplicate-account.js 指定哪些既有收支／結算要搬過去。
 */
const { db, initDatabase, closeDatabase } = require('../database/db');
const { findDuplicateGroups } = require('../utils/accountIdentity');

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));

async function main() {
    await initDatabase();
    const groups = await findDuplicateGroups(db);
    if (!groups.length) {
        console.log('\n沒有身分重複的啟用中銀行帳戶。');
        return closeDatabase();
    }
    for (const g of groups) {
        const a = g[0];
        console.log(`\n身分重複：${a.company_name || '（無公司）'}・${a.account_name}${a.account_number ? '・' + a.account_number : ''}`);
        g.forEach((x) => console.log(`  帳戶 #${x.id}　${x.bank_name || '-'}・${x.account_type || '-'}　系統記的即時餘額 ${Math.round(x.current_balance || 0).toLocaleString('en-US')}　建立 ${x.created_at}`));
        const tx = await dbAll(
            `SELECT id, transaction_date, type, amount, category, description FROM transactions
             WHERE account_name = ? AND IFNULL(company_name,'') = ? AND IFNULL(account_number,'') = ? ORDER BY transaction_date, id`,
            [a.account_name, a.company_name || '', a.account_number || '']);
        const st = await dbAll(
            `SELECT id, settlement_date, actual_balance FROM balance_settlements
             WHERE account_name = ? AND IFNULL(company_name,'') = ? AND IFNULL(account_number,'') = ? ORDER BY settlement_date`,
            [a.account_name, a.company_name || '', a.account_number || '']);
        console.log(`  共用的收支 ${tx.length} 筆、結算 ${st.length} 筆（兩個帳戶都會把它們算進去）；其中轉帳／定存相關：`);
        tx.filter((t) => ['轉帳', '轉定存', '定存到期', '定存解約'].includes(t.category) || /定存/.test(t.description || '')).forEach((t) =>
            console.log(`    收支 #${t.id} ${t.transaction_date} ${t.type === 'income' ? '收入' : '支出'} ${Math.round(t.amount).toLocaleString('en-US')}　${t.category || ''}　${t.description || ''}`));
        st.forEach((s) => console.log(`    結算 #${s.id} ${s.settlement_date} 實際餘額 ${Math.round(s.actual_balance).toLocaleString('en-US')}`));
    }
    console.log('\n下一步：決定哪個帳戶要改名（例如定存加上「定存」），再用 scripts/split-duplicate-account.js（預設只預覽）指定要搬過去的收支與結算。');
    await closeDatabase();
}
main().catch((e) => { console.error(e); process.exit(1); });
