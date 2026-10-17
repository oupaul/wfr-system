// 「這筆借款有沒有被資金預測帶入、沒有的話是為什麼」的診斷。
// 借款管理與週期範本的列表都用它顯示預測狀態，使用者不用再猜是哪個欄位沒設好。
// 判斷順序跟實際投影邏輯（utils/loanSchedule.js）一致；有投影結果就以結果為準，沒有才逐項找原因。
const { dbAll, loadActiveAccounts } = require('./cashGapData');
const { REMAINING_PRINCIPAL_SQL } = require('./financingProjection');
const { transactionBelongsToAccount } = require('./accountMatch');
const { projectLoanSchedule } = require('./loanSchedule');
const { loadLoanSchedules, detectScheduleIssues } = require('./financingSchedule');
const { todayInTaipei, addDaysStr } = require('./dateUtil');

const LEDGER_MONTHS = 12; // 資金流水帳往後顯示的月數

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

function monthsBetween(todayStr, dateStr) {
    const [ty, tm] = todayStr.split('-').map(Number);
    const [dy, dm] = dateStr.split('-').map(Number);
    return (dy - ty) * 12 + (dm - tm);
}

function describeFirst(source, first, today, occurrences) {
    const m = monthsBetween(today, first.transaction_date);
    // amount_source：這筆預計金額的來源。schedule＝依還款計畫表每期金額；fixed＝範本固定金額；loan＝借款自己的下次還款金額
    const amountSource = source === 'template' ? (first.amount_source === 'schedule' ? 'schedule' : 'fixed') : 'loan';
    const scheduleCount = (occurrences || []).filter((o) => o.amount_source === 'schedule').length;
    const base = { ok: true, source, amount_source: amountSource, schedule_periods_projected: scheduleCount, next_date: first.transaction_date, next_amount: first.amount };
    if (m >= LEDGER_MONTHS) {
        return { ...base, level: 'info', message: `首期在 ${first.transaction_date}（約 ${m} 個月後），超過資金流水帳 ${LEDGER_MONTHS} 個月的範圍，目前還看不到` };
    }
    // 首期還在好幾個月以後時特別註明，避免只看近幾個月的人以為沒有預測
    const when = m >= 2 ? `首期 ${first.transaction_date}（約 ${m} 個月後）` : `下次 ${first.transaction_date}`;
    return { ...base, level: 'ok', message: `預測中：${when}、${fmt(first.amount)} 元` };
}

function templateReason(loan, templates, accounts, remaining) {
    // 範本驅動，但沒有投影出任何一期：逐項找原因（只回報第一個範本的最主要原因）
    for (const t of templates) {
        const amount = parseFloat(t.amount) || 0;
        if (amount <= 0) return '連結的範本金額為 0';
        const matched = accounts.some((a) => transactionBelongsToAccount(t, a));
        if (!matched) {
            return `連結範本的帳戶「${t.account_name || '（未選）'}」找不到對應的啟用中銀行帳戶（請編輯範本，重新選擇公司與帳戶）`;
        }
        if (t.end_date && t.next_run_date > t.end_date) return `範本的到期日（${t.end_date}）早於下次產生日（${t.next_run_date}）`;
        if (loan.maturity_date && t.next_run_date > loan.maturity_date) return `範本的下次產生日（${t.next_run_date}）晚於借款到期日（${loan.maturity_date}）`;
        const principal = parseFloat(t.principal_amount) > 0 ? parseFloat(t.principal_amount) : amount;
        if (principal > remaining + 0.005) return `範本每期本金 ${fmt(principal)} 大於借款目前本金餘額 ${fmt(remaining)}`;
    }
    return '範本的設定讓預計還款無法產生，請檢查範本';
}

function loanReason(loan, accountsById, remaining, today) {
    if (!loan.bank_account_id) return '借款未設定「撥款/還款帳戶」';
    if (!accountsById.has(loan.bank_account_id)) return '借款的「撥款/還款帳戶」已停用或不存在';
    if (!loan.next_payment_date) return '未填「下次還款日」（或登記一次還款後被清除；還款頻率為不重複時會這樣）';
    if (loan.next_payment_amount == null || loan.next_payment_amount === '' || !(parseFloat(loan.next_payment_amount) > 0)) {
        return '未填「下次還款金額」（預計還款需要金額；範本的金額不會自動同步到借款）';
    }
    const freq = loan.repayment_frequency;
    if (!freq && loan.next_payment_date < today) return '還款頻率為「不重複」，且下次還款日已過期';
    if (loan.maturity_date && loan.next_payment_date > loan.maturity_date) return `下次還款日（${loan.next_payment_date}）晚於借款到期日（${loan.maturity_date}）`;
    if (parseFloat(loan.next_payment_amount) > remaining + 0.005) {
        return `下次還款金額 ${fmt(loan.next_payment_amount)} 大於目前本金餘額 ${fmt(remaining)}（預計還款以本金餘額為上限）`;
    }
    return '還款排程的設定讓預計還款無法產生，請檢查借款設定';
}

/**
 * @param loanIds 只算這些借款（省略＝全部啟用中借款）
 * @returns Map<loan.id, { ok, level: 'ok'|'info'|'warn', source, message, next_date?, next_amount? }>
 */
async function getLoanProjectionStatuses(loanIds = null) {
    const today = todayInTaipei();
    const horizon = addDaysStr(today, 365 * 3);
    const where = loanIds && loanIds.length ? `WHERE f.id IN (${loanIds.map(() => '?').join(',')})` : '';
    const loans = await dbAll(
        `SELECT f.*, ${REMAINING_PRINCIPAL_SQL} AS remaining_principal FROM financing f ${where}`, loanIds && loanIds.length ? loanIds : []);
    const accounts = await loadActiveAccounts();
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const templates = await dbAll(
        `SELECT * FROM recurring_transactions WHERE is_active = 1 AND next_run_date IS NOT NULL AND financing_id IS NOT NULL`);
    const byLoan = new Map();
    templates.forEach((t) => { if (!byLoan.has(t.financing_id)) byLoan.set(t.financing_id, []); byLoan.get(t.financing_id).push(t); });

    const schedules = await loadLoanSchedules(dbAll, loans.map((l) => l.id)).catch(() => new Map());
    const result = new Map();
    loans.forEach((loan) => {
        const remaining = Math.max(0, parseFloat(loan.remaining_principal) || 0);
        const linked = byLoan.get(loan.id) || [];
        if (!loan.is_active) return result.set(loan.id, { ok: false, level: 'info', source: null, message: '借款已停用，不預測' });
        if (remaining <= 0) return result.set(loan.id, { ok: false, level: 'warn', source: linked.length ? 'template' : 'loan', message: '目前本金餘額為 0（已還清，或原始本金／手動餘額填成 0），不預測' });

        const sched = schedules.get(loan.id);
        const { source, occurrences } = projectLoanSchedule(loan, linked, today, horizon, remaining, sched ? sched.openPeriods : null);
        if (occurrences.length) {
            const first = occurrences.slice().sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))[0];
            // 範本驅動時還要確認範本的帳戶真的對得上銀行帳戶，否則流水帳其實不會顯示
            if (source === 'template') {
                const anyMatched = linked.some((t) => accounts.some((a) => transactionBelongsToAccount(t, a)));
                if (!anyMatched) return result.set(loan.id, { ok: false, level: 'warn', source, message: templateReason(loan, linked, accounts, remaining) });
            } else if (!accountsById.has(loan.bank_account_id)) {
                return result.set(loan.id, { ok: false, level: 'warn', source, message: loanReason(loan, accountsById, remaining, today) });
            }
            return result.set(loan.id, describeFirst(source, first, today, occurrences));
        }

        // 沒有任何預計還款：找原因
        const hasAnySchedule = linked.length || loan.next_payment_date || loan.next_payment_amount || loan.repayment_frequency || loan.bank_account_id;
        if (!hasAnySchedule) {
            return result.set(loan.id, { ok: false, level: 'info', source: 'loan', message: '未設定還款排程（不會出現在資金預測）；要預測請設定還款帳戶、頻率、下次還款日與金額，或建立連結的週期範本' });
        }
        const message = source === 'template' ? templateReason(loan, linked, accounts, remaining) : loanReason(loan, accountsById, remaining, today);
        result.set(loan.id, { ok: false, level: 'warn', source, message });
    });
    // 有計畫表的借款：不論有沒有預測成功，都附上計畫表是否可能過期的提醒（實際還款金額不同、已跑完仍有本金、餘額差距）
    loans.forEach((loan) => {
        const sched = schedules.get(loan.id);
        const st = result.get(loan.id);
        if (!sched || !st || !loan.is_active) return;
        st.has_schedule = true;
        st.schedule_issues = detectScheduleIssues(sched.periods, sched.repayments, Math.max(0, parseFloat(loan.remaining_principal) || 0), today);
        if ((byLoan.get(loan.id) || []).length > 1) st.schedule_note = '這筆借款連結了多個週期範本，預測金額不套用計畫表（避免同一期算兩次）';
    });
    return result;
}

module.exports = { getLoanProjectionStatuses };
