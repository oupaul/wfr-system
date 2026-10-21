/**
 * 把「公司＋帳戶名稱＋帳號完全相同」的兩個銀行帳戶分開。
 *
 * 做三件事（預設只預覽、不寫入，加 --apply 才真的做）：
 *   1. 把 --split 指定的帳戶改成新的帳戶名稱（--new-name）
 *   2. 把 --move-tx 指定的收支記錄、--move-settlements 指定的結算記錄，改成新的帳戶名稱
 *      （其餘仍屬於原本的帳戶）
 *   3. 重算兩個帳戶的即時餘額
 * 要搬哪些記錄由你決定（用 scripts/find-duplicate-accounts.js 先看有哪些），系統無法自己判斷哪些屬於哪個帳戶。
 * 轉帳是一組兩筆：例如活存轉定存，轉出那筆留在活存、轉入那筆要搬到定存，兩筆都要看清楚再決定。
 *
 * 用法：
 *   node scripts/split-duplicate-account.js --split 11 --new-name "和鋕科技股份有限公司-定存" --move-tx 42,39
 *   node scripts/split-duplicate-account.js --split 11 --new-name "..." --move-tx 42,39 --move-settlements 12 --apply
 * 套用前會先把資料庫複製一份到 backups/（檔名含時間）。請先停止服務或確認沒有人正在操作，再執行 --apply。
 */
const fs = require('fs');
const path = require('path');
const { db, initDatabase, closeDatabase } = require('../database/db');
const { findIdentityConflict, identityKey } = require('../utils/accountIdentity');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');
const { norm } = require('../utils/accountMatch');
const { fileTimestampInTaipei } = require('../utils/dateUtil');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const splitId = parseInt(arg('--split'), 10);
const newName = (arg('--new-name') || '').trim();
const ids = (v) => (v ? v.split(',').map((x) => parseInt(x, 10)).filter(Number.isFinite) : []);
const moveTx = ids(arg('--move-tx'));
const moveSt = ids(arg('--move-settlements'));

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this); }));
const fail = (msg) => { console.error('\n✗ ' + msg); process.exit(1); };

async function main() {
    if (!Number.isFinite(splitId) || !newName) fail('用法：node scripts/split-duplicate-account.js --split <帳戶ID> --new-name "<新帳戶名稱>" [--move-tx 42,39] [--move-settlements 12] [--apply]');
    await initDatabase();

    const [acc] = await dbAll(`SELECT ba.*, c.name AS company_name FROM bank_accounts ba LEFT JOIN companies c ON c.id = ba.company_id WHERE ba.id = ?`, [splitId]);
    if (!acc) fail(`找不到帳戶 #${splitId}`);
    if (!acc.is_active) fail(`帳戶 #${splitId} 已停用`);
    const other = await findIdentityConflict(db, { company_id: acc.company_id, account_name: acc.account_name, account_number: acc.account_number }, splitId);
    if (!other) fail(`帳戶 #${splitId} 沒有與其他啟用中帳戶身分重複，不需要分開`);
    const clash = await findIdentityConflict(db, { company_id: acc.company_id, account_name: newName, account_number: acc.account_number }, splitId);
    if (clash) fail(`新名稱「${newName}」已被帳戶 #${clash.id} 使用`);
    if (newName === acc.account_name) fail('新名稱與原名稱相同');

    const oldIdentity = { company_name: acc.company_name || '', account_name: acc.account_name, account_number: acc.account_number || '' };
    const sameOld = (r) => identityKey(r) === identityKey(oldIdentity);
    const txs = moveTx.length ? await dbAll(`SELECT * FROM transactions WHERE id IN (${moveTx.map(() => '?').join(',')})`, moveTx) : [];
    const sts = moveSt.length ? await dbAll(`SELECT * FROM balance_settlements WHERE id IN (${moveSt.map(() => '?').join(',')})`, moveSt) : [];
    moveTx.forEach((id) => { const t = txs.find((x) => x.id === id); if (!t) fail(`找不到收支 #${id}`); if (!sameOld(t)) fail(`收支 #${id} 不屬於原本這個身分（公司／名稱／帳號不同），請確認編號`); });
    moveSt.forEach((id) => { const t = sts.find((x) => x.id === id); if (!t) fail(`找不到結算 #${id}`); if (!sameOld(t)) fail(`結算 #${id} 不屬於原本這個身分，請確認編號`); });

    console.log(`\n要分開的帳戶：#${acc.id} ${acc.bank_name || ''}・${acc.account_type || ''}`);
    console.log(`  原身分：${oldIdentity.company_name}・${oldIdentity.account_name}・${oldIdentity.account_number}（另一個沿用此身分的帳戶：#${other.id} ${other.bank_name || ''}・${other.account_type || ''}）`);
    console.log(`  新帳戶名稱：${newName}`);
    console.log(`  搬移收支 ${txs.length} 筆：`);
    txs.forEach((t) => console.log(`    #${t.id} ${t.transaction_date} ${t.type === 'income' ? '收入' : '支出'} ${Math.round(t.amount).toLocaleString('en-US')}　${t.category || ''} ${t.description || ''}`));
    console.log(`  搬移結算 ${sts.length} 筆：`);
    sts.forEach((t) => console.log(`    #${t.id} ${t.settlement_date} 實際餘額 ${Math.round(t.actual_balance).toLocaleString('en-US')}`));

    if (!APPLY) {
        console.log('\n（預覽，尚未修改任何資料。確認無誤後加上 --apply 執行；執行前會先備份資料庫。）');
        return closeDatabase();
    }

    const dbFile = path.join(__dirname, '..', 'database', 'fund_report.db');
    const backupDir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `before-split-account-${fileTimestampInTaipei()}.db`);
    fs.copyFileSync(dbFile, backup);
    console.log(`\n已備份資料庫：${backup}`);

    await dbRun('BEGIN IMMEDIATE');
    try {
        await dbRun('UPDATE bank_accounts SET account_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newName, splitId]);
        if (moveTx.length) await dbRun(`UPDATE transactions SET account_name = ? WHERE id IN (${moveTx.map(() => '?').join(',')})`, [newName, ...moveTx]);
        if (moveSt.length) await dbRun(`UPDATE balance_settlements SET account_name = ? WHERE id IN (${moveSt.map(() => '?').join(',')})`, [newName, ...moveSt]);
        await dbRun('COMMIT');
    } catch (e) {
        await dbRun('ROLLBACK').catch(() => {});
        fail('寫入失敗，已復原：' + e.message);
    }

    // 重算兩個帳戶的即時餘額
    const refs = [
        { company_name: acc.company_name, account_name: newName, account_number: acc.account_number },
        { company_name: acc.company_name, account_name: other.account_name, account_number: other.account_number }
    ];
    for (const r of refs) await updateBankAccountBalance(r.account_name, r.account_number || null, r.company_name || null);
    const after = await dbAll('SELECT id, account_name, account_type, current_balance FROM bank_accounts WHERE id IN (?, ?)', [splitId, other.id]);
    console.log('\n✓ 已完成。兩個帳戶目前的即時餘額：');
    after.forEach((a) => console.log(`  #${a.id} ${a.account_name}（${a.account_type || '-'}）：${Math.round(a.current_balance).toLocaleString('en-US')}`));
    console.log('請到「銀行帳戶管理」按「🔄 重新計算餘額」，並對照銀行實際餘額確認；有問題可用上面的備份檔還原。');
    await closeDatabase();
}
main().catch((e) => { console.error(e); process.exit(1); });
