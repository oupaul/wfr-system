// 借款「還款計畫表」的檢視與核對：每期是否已還、下一期該還多少、計畫表顯示的目前餘額與系統是否一致。
//
// 計畫表只是「應該怎麼還」的參考資料，不會自動寫入任何收支或還款記錄；真正的還款記錄仍由使用者登記
// （或週期範本「產生下一筆」）。這裡把實際的還款記錄依日期對應到計畫的各期，用來顯示狀態與帶入建議。

const MATCH_DAYS = 20; // 還款日期距離某一期到期日在這個天數內，視為那一期的還款

function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// 一對一對應：每筆還款對到「最近的、還沒被對走的」一期（距離不超過 MATCH_DAYS）
function matchRepaymentsToPeriods(periods, repayments) {
    const matched = new Map(); // period_no -> repayment
    const used = new Set();
    const candidates = [];
    repayments.forEach((r) => {
        periods.forEach((p) => {
            const diff = Math.abs(daysBetween(p.due_date, r.payment_date));
            if (diff <= MATCH_DAYS) candidates.push({ r, p, diff });
        });
    });
    candidates.sort((a, b) => a.diff - b.diff);
    candidates.forEach(({ r, p }) => {
        if (used.has(r.id) || matched.has(p.period_no)) return;
        matched.set(p.period_no, r);
        used.add(r.id);
    });
    return matched;
}

/**
 * @param loan { remaining_principal（目前本金餘額，系統算的） }
 * @param periods 計畫表各期（依 period_no）
 * @param repayments 還款記錄
 * @returns { periods: [{..., status, repayment }], summary }
 *   status：paid 已還／scheduled 已登記但還款日在未來／overdue 已過到期日還沒還／upcoming 30 天內到期／future 之後
 */
function buildScheduleView(loan, periods, repayments, today) {
    const sorted = periods.slice().sort((a, b) => a.period_no - b.period_no);
    const matched = matchRepaymentsToPeriods(sorted, repayments);
    const rows = sorted.map((p) => {
        const repayment = matched.get(p.period_no) || null;
        let status = 'future';
        // 已有還款記錄：日期已到（≤ 今天）算已還；日期在未來是「已登記但尚未發生」（例如範本提前產生）
        if (repayment) status = repayment.payment_date <= today ? 'paid' : 'scheduled';
        else if (p.due_date <= today) status = 'overdue';
        else if (daysBetween(today, p.due_date) <= 30) status = 'upcoming';
        return {
            ...p,
            principal: parseFloat(p.principal) || 0, interest: parseFloat(p.interest) || 0, fee: parseFloat(p.fee) || 0,
            balance_after: p.balance_after == null ? null : parseFloat(p.balance_after),
            status,
            repayment: repayment ? { id: repayment.id, payment_date: repayment.payment_date, principal_paid: repayment.principal_paid, interest_paid: repayment.interest_paid } : null
        };
    });

    const due = rows.filter((r) => r.due_date <= today);
    const lastDue = due.length ? due[due.length - 1] : null;
    const nextUnpaid = rows.find((r) => r.status !== 'paid' && r.status !== 'scheduled') || null;
    const systemBalance = parseFloat(loan.remaining_principal) || 0;
    let expectedBalance = null;
    if (lastDue && lastDue.balance_after != null) expectedBalance = lastDue.balance_after;
    // 校正用的基準日：計畫表餘額已包含「到期日 ≤ 今天」各期的還款，所以基準日要不早於這些期對應還款的實際日期
    // （例如第 2 期 10/01 到期、10/05 才繳：基準日取 10/05，否則 10/05 那筆會被再扣一次）
    let calibrationDate = lastDue ? lastDue.due_date : null;
    due.forEach((r) => { if (r.repayment && r.repayment.payment_date > calibrationDate && r.repayment.payment_date <= today) calibrationDate = r.repayment.payment_date; });
    const summary = {
        calibration_date: calibrationDate,
        total_periods: rows.length,
        due_periods: due.length,
        paid_periods: rows.filter((r) => r.status === 'paid').length,
        scheduled_periods: rows.filter((r) => r.status === 'scheduled').length,
        overdue_periods: rows.filter((r) => r.status === 'overdue').length,
        last_due_period: lastDue ? lastDue.period_no : null,
        last_due_date: lastDue ? lastDue.due_date : null,
        expected_balance: expectedBalance,
        system_balance: systemBalance,
        diff: expectedBalance == null ? null : systemBalance - expectedBalance,
        next_unpaid: nextUnpaid ? { period_no: nextUnpaid.period_no, due_date: nextUnpaid.due_date, principal: nextUnpaid.principal, interest: nextUnpaid.interest, fee: nextUnpaid.fee, status: nextUnpaid.status } : null
    };
    return { periods: rows, summary };
}

// 給「產生下一筆」／新增還款帶入用的建議：這個日期附近、還沒有還款記錄的那一期
function suggestForDate(view, dateStr) {
    const candidates = view.periods
        .filter((p) => p.status !== 'paid' && p.status !== 'scheduled')
        .map((p) => ({ p, diff: Math.abs(daysBetween(p.due_date, dateStr)) }))
        .filter((x) => x.diff <= MATCH_DAYS)
        .sort((a, b) => a.diff - b.diff);
    if (!candidates.length) return null;
    const p = candidates[0].p;
    return {
        period_no: p.period_no, due_date: p.due_date, principal: p.principal, interest: p.interest, fee: p.fee,
        interest_with_fee: Math.round((p.interest + p.fee) * 100) / 100, // 登記還款時利息欄＝利息＋費用（營業稅等），總支出才跟銀行扣款一致
        balance_after: p.balance_after
    };
}

module.exports = { buildScheduleView, suggestForDate, matchRepaymentsToPeriods, MATCH_DAYS };
