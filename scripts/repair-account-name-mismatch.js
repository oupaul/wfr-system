/**
 * 修復銀行帳戶改名/改帳號/換公司後，收支記錄與結算記錄裡殘留舊文字的問題。
 *
 * 背景：transactions / balance_settlements 存的 company_name / account_name /
 * account_number 是建立當下複製的文字，不是外鍵。若在這次修正（銀行帳戶更新時
 * 自動同步收支/結算記錄）之前就已經改過帳戶名稱、帳號或所屬公司，既有的收支/
 * 結算記錄會停留在舊文字，之後資金流水帳／資金缺口計算會找不到這些記錄而漏算。
 *
 * 安全性限制：只有在「公司＋帳號」能唯一鎖定一個銀行帳戶時，才會判斷／修復。
 * 若同一間公司底下有多個帳戶都沒有填「帳號」，光靠公司名稱無法分辨這些舊記錄
 * 原本屬於哪一個帳戶，本工具不會亂猜、不會自動修復，只會列出來提醒您改用手動
 * 方式確認（或補上真實帳號讓資料可以被唯一辨識）。
 *
 * 用法：
 *   node scripts/repair-account-name-mismatch.js         # 只列出偵測到的不一致，不寫入
 *   node scripts/repair-account-name-mismatch.js --fix    # 列出後實際修復（只處理可唯一判斷的部分）
 */
const { db, initDatabase, closeDatabase } = require('../database/db');

const shouldFix = process.argv.includes('--fix');

function dbAll(query, params) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

function dbRun(query, params) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) { err ? reject(err) : resolve(this); });
    });
}

async function main() {
    await initDatabase();

    const accounts = await dbAll(
        `SELECT ba.id, ba.account_name, ba.account_number, c.name as company_name
         FROM bank_accounts ba
         LEFT JOIN companies c ON ba.company_id = c.id`,
        []
    );

    // 同一公司底下，有多少帳戶的 account_number 是 NULL——超過 1 個就無法唯一辨識
    const nullAccountNumberCountByCompany = new Map();
    for (const acc of accounts) {
        if (!acc.company_name || acc.account_number) continue;
        nullAccountNumberCountByCompany.set(
            acc.company_name,
            (nullAccountNumberCountByCompany.get(acc.company_name) || 0) + 1
        );
    }

    let totalFixable = 0;
    let totalAmbiguous = 0;

    for (const acc of accounts) {
        if (!acc.company_name) continue;

        const isAmbiguous = !acc.account_number
            && (nullAccountNumberCountByCompany.get(acc.company_name) || 0) > 1;

        for (const table of ['transactions', 'balance_settlements']) {
            const mismatches = await dbAll(
                `SELECT id, company_name, account_name, account_number FROM ${table}
                 WHERE company_name = ?
                   AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                   AND account_name != ?`,
                [acc.company_name, acc.account_number || null, acc.account_number || null, acc.account_name]
            );

            if (mismatches.length === 0) continue;

            if (isAmbiguous) {
                totalAmbiguous += mismatches.length;
                console.log(`\n⚠️  [${table}] 公司「${acc.company_name}」有多個帳戶沒有填「帳號」，無法自動判斷這 ${mismatches.length} 筆記錄原本屬於哪個帳戶（其中一個候選是「${acc.account_name}」），已略過，請自行確認或補上帳號後再重跑。`);
                const sample = [...new Set(mismatches.map(m => m.account_name))].slice(0, 5);
                sample.forEach(name => console.log(`    - "${name}"`));
                continue;
            }

            totalFixable += mismatches.length;
            console.log(`\n[${table}] 帳戶「${acc.company_name} - ${acc.account_name}」(帳號: ${acc.account_number || '無（此公司下僅此一戶無帳號，可唯一判斷）'})`);
            console.log(`  找到 ${mismatches.length} 筆記錄的 account_name 是舊文字，例如：`);
            const sample = [...new Set(mismatches.map(m => m.account_name))].slice(0, 5);
            sample.forEach(name => console.log(`    - "${name}"`));

            if (shouldFix) {
                const result = await dbRun(
                    `UPDATE ${table} SET account_name = ?
                     WHERE company_name = ?
                       AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))
                       AND account_name != ?`,
                    [acc.account_name, acc.company_name, acc.account_number || null, acc.account_number || null, acc.account_name]
                );
                console.log(`  ✓ 已修復 ${result.changes} 筆，account_name 改為 "${acc.account_name}"`);
            }
        }
    }

    if (totalFixable === 0 && totalAmbiguous === 0) {
        console.log('沒有偵測到帳戶名稱不一致的記錄。');
    } else {
        if (totalFixable > 0 && !shouldFix) {
            console.log(`\n共偵測到 ${totalFixable} 筆可安全修復的不一致記錄。加上 --fix 參數重新執行即可實際修復：`);
            console.log('  node scripts/repair-account-name-mismatch.js --fix');
        } else if (totalFixable > 0) {
            console.log(`\n修復完成，共處理 ${totalFixable} 筆記錄。建議接著到「銀行帳戶」頁按一次「重新計算餘額」。`);
        }
        if (totalAmbiguous > 0) {
            console.log(`\n另外有 ${totalAmbiguous} 筆記錄因為同公司有多個帳戶都沒有帳號、無法唯一判斷，未被處理——建議先到「銀行帳戶管理」為這些帳戶補上真實帳號，再重跑本腳本。`);
        }
    }

    await closeDatabase();
}

main().catch((err) => {
    console.error('修復腳本執行失敗:', err);
    process.exit(1);
});
