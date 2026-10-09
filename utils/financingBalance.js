// 借款每一期還款「還款後的本金餘額」：讓使用者逐期對照銀行對帳單的貸款餘額，找出哪一期的本金／利息填錯。
// 定義跟目前本金餘額（utils/financingProjection.js 的 REMAINING_PRINCIPAL_SQL）一致：
//   - 自動模式：原始本金 − 累計已還本金（只有「本金」會讓餘額減少，利息不扣本金）
//   - 手動輸入模式：以手動餘額為「基準日當天結束時」的餘額；基準日之後的還款繼續往下扣，
//     基準日當天或之前的還款視為已包含在手動餘額內，所以它們的還款後餘額由手動餘額往回推。

/**
 * @param fin { principal_amount, manual_principal_balance, manual_balance_date }
 * @param rows 還款記錄（任意順序）{ id, payment_date, principal_paid }
 * @returns Map<repayment.id, 還款後本金餘額>
 */
function balancesAfterEachRepayment(fin, rows) {
    const asc = rows.slice().sort((a, b) => (a.payment_date === b.payment_date ? a.id - b.id : a.payment_date.localeCompare(b.payment_date)));
    const result = new Map();
    const principalOf = (r) => parseFloat(r.principal_paid) || 0;

    if (fin.manual_principal_balance == null) {
        let running = parseFloat(fin.principal_amount) || 0;
        asc.forEach((r) => { running -= principalOf(r); result.set(r.id, running); });
        return result;
    }

    const manual = parseFloat(fin.manual_principal_balance) || 0;
    const base = fin.manual_balance_date || '';
    const upToBase = asc.filter((r) => r.payment_date <= base);
    const afterBase = asc.filter((r) => r.payment_date > base);

    let running = manual;
    afterBase.forEach((r) => { running -= principalOf(r); result.set(r.id, running); });

    // 基準日當天或之前：手動餘額是這些還款「全部做完之後」的餘額，往回加上排在後面的本金
    let suffix = 0;
    for (let i = upToBase.length - 1; i >= 0; i--) {
        result.set(upToBase[i].id, manual + suffix);
        suffix += principalOf(upToBase[i]);
    }
    return result;
}

module.exports = { balancesAfterEachRepayment };
