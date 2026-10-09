// 定存相關的共用計算：利息估算、以及把「定存到期」投影成未來的轉帳事件。
//
// 定存仍是一般的銀行帳戶（帳戶類型「定存」），只是多了幾個選填欄位：年利率、起存日、到期日，
// 以及到期／解約時轉回的活存帳戶（見 database/db.js migrateBankAccountsDeposit）。
// 未到期的定存在資金預估週報（流水帳／帳戶卡片）裡會以「（預計）」事件呈現：
// 到期日定存帳戶轉出本金、轉回的活存帳戶轉入本金與預估利息。這些預計事件不會寫進收支記錄，
// 要到期當天按「解約／到期」才會產生真實的轉帳與利息收入，之後預計事件就消失。

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(startStr, endStr) {
    const s = Date.parse(`${startStr}T00:00:00Z`);
    const e = Date.parse(`${endStr}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
    return Math.max(0, Math.round((e - s) / MS_PER_DAY));
}

// 單利估算：本金 × 年利率% × 天數 / 365，取整數元。缺利率或起存日時回傳 0
function estimateInterest(principal, ratePercent, startDate, endDate) {
    const p = parseFloat(principal);
    const r = parseFloat(ratePercent);
    if (!(p > 0) || !(r > 0) || !startDate || !endDate) return 0;
    return Math.round(p * (r / 100) * daysBetween(startDate, endDate) / 365);
}

// 某帳戶在 dateStr（含）當天的餘額：期初 + 到該日為止的真實收支
function balanceAt(input, dateStr) {
    if (!input) return 0;
    let balance = input.openingBalance || 0;
    (input.rows || []).forEach((t) => {
        if (t.transaction_date > dateStr) return;
        const amt = parseFloat(t.amount) || 0;
        balance += t.type === 'income' ? amt : -amt;
    });
    return balance;
}

/**
 * @param accounts 啟用中的銀行帳戶（含 deposit_* 欄位）
 * @param inputs Map<account.id, { openingBalance, rows }>（cashGap 的 loadAccountInputs 結果）
 * @returns Map<account.id, 預計事件[]>
 */
function projectDepositRows(accounts, inputs, todayStr, maxDateStr) {
    const result = new Map();
    accounts.forEach((a) => result.set(a.id, []));
    const byId = new Map(accounts.map((a) => [a.id, a]));

    accounts.forEach((dep) => {
        if (dep.account_type !== '定存' || !dep.deposit_maturity_date) return;
        const target = byId.get(Number(dep.deposit_return_account_id));
        if (!target || target.id === dep.id) return; // 沒指定或找不到（停用）轉回帳戶就不投影

        const overdue = dep.deposit_maturity_date < todayStr;
        const date = overdue ? todayStr : dep.deposit_maturity_date; // 已到期未確認：落在今天，避免缺口被低估
        if (date > maxDateStr) return;

        // 以到期日當天的餘額為本金；如果已經提前登記了解約轉帳，餘額會是 0，就不重複投影
        const principal = balanceAt(inputs.get(dep.id), date);
        if (!(principal > 0.005)) return;

        const interest = estimateInterest(principal, dep.deposit_interest_rate, dep.deposit_start_date, dep.deposit_maturity_date);
        const tag = overdue ? '（預計・定存已到期未確認）' : '（預計）';
        result.get(dep.id).push({
            transaction_date: date, type: 'expense', amount: principal,
            description: `${tag}${dep.account_name} 到期轉出`, is_projected: true, is_transfer: true
        });
        result.get(target.id).push({
            transaction_date: date, type: 'income', amount: principal,
            description: `${tag}${dep.account_name} 到期轉入`, is_projected: true, is_transfer: true
        });
        if (interest > 0) {
            result.get(target.id).push({
                transaction_date: date, type: 'income', amount: interest,
                description: `${tag}${dep.account_name} 預估利息`, is_projected: true
            });
        }
    });
    return result;
}

module.exports = { daysBetween, estimateInterest, balanceAt, projectDepositRows };
