/**
 * 診斷帳戶間轉帳：找出「一腿有影響餘額、另一腿沒有」的轉帳（唯讀，不會修改任何資料）。
 *
 * 常見的疑惑是「從 A 銀行轉到 B 銀行，A 沒減少、B 有增加」。轉帳會同時寫兩筆收支（轉出支出＋轉入收入），
 * 但每個帳戶算餘額時只算「最近一次結算日之後」的交易（結算金額已視為包含更早的交易）。
 * 兩個帳戶的結算日不同時，轉帳日期落在其中一個帳戶的結算日之前，那一腿就不會影響該帳戶的目前餘額。
 * 另一個可能是那一腿的公司／帳戶名稱／帳號與任何啟用中銀行帳戶對不上。這支工具把兩種情況都列出來。
 *
 * 用法：
 *   node scripts/diagnose-transfers.js            只列出有問題的轉帳（預設只看最近 90 天）
 *   node scripts/diagnose-transfers.js --all      列出所有轉帳（含正常的）
 *   node scripts/diagnose-transfers.js --days 365 看最近 365 天
 */
const { db, initDatabase, closeDatabase } = require('../database/db');
const { describeBalanceImpact } = require('../utils/bankAccountBalance');
const { todayInTaipei, addDaysStr } = require('../utils/dateUtil');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) || 90 : 90;

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));

async function main() {
    await initDatabase();
    const since = addDaysStr(todayInTaipei(), -DAYS);
    const rows = await dbAll(
        `SELECT id, transaction_date, type, amount, company_name, account_name, account_number, category, transfer_group_id
         FROM transactions WHERE transfer_group_id IS NOT NULL AND transaction_date >= ? ORDER BY transaction_date DESC, transfer_group_id, type DESC`, [since]);
    const groups = new Map();
    rows.forEach((r) => { if (!groups.has(r.transfer_group_id)) groups.set(r.transfer_group_id, []); groups.get(r.transfer_group_id).push(r); });

    let problems = 0;
    for (const [gid, legs] of groups) {
        const results = [];
        for (const leg of legs) {
            const imp = await describeBalanceImpact(leg, leg.transaction_date);
            results.push({ leg, imp });
        }
        const bad = results.filter((x) => !x.imp.counted && !/未來/.test(x.imp.reason || ''));
        const asym = results.some((x) => x.imp.counted) && bad.length > 0;
        if (!ALL && bad.length === 0) continue;
        problems += bad.length ? 1 : 0;
        console.log(`\n轉帳 ${legs[0].transaction_date}　${Math.round(legs[0].amount).toLocaleString('en-US')} 元　（群組 ${gid.slice(0, 8)}）${asym ? '　⚠ 一腿有影響、一腿沒有' : ''}`);
        results.forEach(({ leg, imp }) => {
            const who = `${leg.company_name || '（無公司）'}・${leg.account_name}${leg.account_number ? '・' + leg.account_number : ''}`;
            console.log(`  ${leg.type === 'expense' ? '轉出' : '轉入'} #${leg.id} ${who}：${imp.counted ? '✓ 有影響目前餘額' : '✗ ' + imp.reason}`);
        });
    }
    console.log(`\n共 ${groups.size} 組轉帳（最近 ${DAYS} 天），其中 ${problems} 組有一腿不會影響目前餘額。`);
    if (problems) console.log('處理方式：日期早於結算日者，確認該帳戶結算金額是否已包含這筆；帳戶對不上者，請到「收支記錄」修正公司／帳戶，或用 scripts/find-unmatched-transactions.js 找出全部。');
    await closeDatabase();
}
main().catch((e) => { console.error(e); process.exit(1); });
