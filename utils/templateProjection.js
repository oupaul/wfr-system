// 把啟用中的「週期範本」投影成未來的收支事件，併入資金流水帳／資金缺口的預測。
//
// 範本金額通常是預估值，真正發生時使用者會在「產生下一筆」確認視窗輸入實際金額，
// 所以這裡投影出來的列一律標成「（預計）」；按下產生後範本的下次產生日會往後推，
// 那一筆就變成真實交易，不會重複計算。
//
// - 已逾期（下次產生日 < 今天）還沒產生的期數全部落在「今天」，避免資金缺口被低估
// - 連結借款的範本：以「範本」為準投影（金額、頻率、下次產生日、到期日、帳戶都取自範本，
//   因為使用者平常維護、按「產生下一筆」的是範本）；這時借款自己的下次還款日／金額排程不再投影，
//   避免同一筆還款算兩次（見 utils/financingProjection.js 的 NOT EXISTS 條件）。
//   連結借款的範本另外受借款限制：借款停用、本金餘額為 0 就不投影，累計投影的本金不超過目前本金餘額，
//   也不超過借款到期日。
//   連結借款若匯入了「還款計畫表」（且只有一個啟用中的連結範本），每一期的預計金額改用計畫表該期的
//   本金＋利息＋費用（依日期對應最近、還沒還的一期，相差不超過 20 天）；對不到的期數退回範本金額。
//   所以租金調降、利息遞減等每期金額不同的借款，不用手動改範本金額。
// - 超過 end_date 的期數不投影

const { addMonthsClamped, REMAINING_PRINCIPAL_SQL } = require('./financingProjection');
const { transactionBelongsToAccount } = require('./accountMatch');
const { loadLoanSchedules, daysBetween, MATCH_DAYS } = require('./financingSchedule');

const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const MAX_OCCURRENCES = 60;

// loanInfo：連結借款的範本才需要，{ remaining（目前本金餘額）, maturityDate, isActive, openPeriods?（計畫表還沒還的期數） }
function projectTemplateOccurrences(template, todayStr, maxDateStr, loanInfo = null) {
    if (!template || !template.next_run_date || !template.is_active) return [];
    if (template.financing_id && !loanInfo) return []; // 連結借款卻沒有借款資訊，無法判斷上限，不投影
    const amount = parseFloat(template.amount) || 0;
    if (amount <= 0) return [];
    if (loanInfo && (loanInfo.isActive === 0 || loanInfo.isActive === false || !(loanInfo.remaining > 0))) return [];
    // 連結借款：每期「本金」部分累計不超過目前本金餘額（沒拆本金／利息就把整期金額當本金，保守）
    const principalPerRun = loanInfo
        ? (parseFloat(template.principal_amount) > 0 ? parseFloat(template.principal_amount) : amount)
        : 0;
    let cumulativePrincipal = 0;
    const openPeriods = loanInfo && Array.isArray(loanInfo.openPeriods) && loanInfo.openPeriods.length ? loanInfo.openPeriods.slice() : null;
    const usedPeriods = new Set();

    const stepMonths = STEP_MONTHS[template.frequency] || 1;
    const baseLabel = template.description || template.category || '週期範本';
    const occurrences = [];
    let cursor = template.next_run_date;
    let iterations = 0;

    while (iterations < MAX_OCCURRENCES) {
        if (template.end_date && cursor > template.end_date) break;
        let occAmount = amount;
        let amountSource = 'fixed';
        let periodNo = null;
        if (loanInfo) {
            if (loanInfo.maturityDate && cursor > loanInfo.maturityDate) break;
            // 計畫表：對應最近、還沒用過的一期（相差 MATCH_DAYS 天內）；對不到就用範本金額
            let period = null;
            if (openPeriods) {
                let bestDiff = Infinity;
                openPeriods.forEach((p) => {
                    if (usedPeriods.has(p.period_no)) return;
                    const diff = Math.abs(daysBetween(p.due_date, cursor));
                    if (diff <= MATCH_DAYS && diff < bestDiff) { period = p; bestDiff = diff; }
                });
            }
            if (period) {
                usedPeriods.add(period.period_no);
                // 本金不超過剩餘本金：最後一期若差幾元就把超過的部分扣掉，不要整期被丟掉
                const left = loanInfo.remaining - cumulativePrincipal;
                if (left <= 0.005) break;
                const allowed = Math.min(period.principal, left);
                occAmount = Math.round((period.amount - (period.principal - allowed)) * 100) / 100;
                cumulativePrincipal += allowed;
                amountSource = 'schedule';
                periodNo = period.period_no;
            } else {
                if (cumulativePrincipal + principalPerRun > loanInfo.remaining + 0.005) break;
                cumulativePrincipal += principalPerRun;
            }
        }
        const isOverdue = cursor < todayStr;
        const eventDate = isOverdue ? todayStr : cursor;
        if (eventDate > maxDateStr) break;
        occurrences.push({
            transaction_date: eventDate,
            type: template.type,
            amount: occAmount,
            description: `（預計${isOverdue ? '・已逾期未確認' : ''}）${baseLabel}`,
            is_projected: true,
            amount_source: amountSource,
            period_no: periodNo
        });
        cursor = addMonthsClamped(cursor, stepMonths);
        iterations++;
    }
    return occurrences;
}

// 一次查出所有啟用中的範本，再依帳戶的公司/帳戶名稱/帳號比對（範本跟交易一樣存的是去正規化文字）。
// 比對規則與收支記錄歸戶完全相同（見 utils/accountMatch.js）：公司、帳戶名稱、帳號三項嚴格比對，空值視為相同。回傳 Map<account.id, 預計事件[]>。
// 永遠 resolve，查詢失敗只記錄錯誤、回傳空陣列。
function getProjectedTemplateRowsByAccount(db, accounts, todayStr, maxDateStr) {
    const all = (sql, params) => new Promise((res, rej) => db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows || []))));
    const result = new Map();
    (accounts || []).forEach((a) => result.set(a.id, []));
    return all(
        `SELECT rt.*, f.is_active AS loan_is_active, f.maturity_date AS loan_maturity_date,
                ${REMAINING_PRINCIPAL_SQL} AS loan_remaining
         FROM recurring_transactions rt
         LEFT JOIN financing f ON f.id = rt.financing_id
         WHERE rt.is_active = 1 AND rt.next_run_date IS NOT NULL`, [])
        .then(async (templates) => {
            // 借款只有「一個」啟用中的連結範本時才套用計畫表金額（有兩個以上就不套，避免同一期被算兩次）
            const perLoan = new Map();
            templates.forEach((t) => { if (t.financing_id) perLoan.set(t.financing_id, (perLoan.get(t.financing_id) || 0) + 1); });
            const soleLoanIds = [...perLoan.entries()].filter(([, n]) => n === 1).map(([id]) => id);
            let schedules = new Map();
            try {
                schedules = await loadLoanSchedules(all, soleLoanIds);
            } catch (err) {
                console.error('[範本投影] 載入還款計畫表失敗（改用範本金額）:', err.message);
            }
            (accounts || []).forEach((account) => {
                templates.forEach((t) => {
                    if (transactionBelongsToAccount(t, account)) {
                        const sched = t.financing_id ? schedules.get(t.financing_id) : null;
                        const loanInfo = t.financing_id
                            ? { remaining: parseFloat(t.loan_remaining) || 0, maturityDate: t.loan_maturity_date, isActive: t.loan_is_active, openPeriods: sched ? sched.openPeriods : null }
                            : null;
                        result.get(account.id).push(...projectTemplateOccurrences(t, todayStr, maxDateStr, loanInfo));
                    }
                });
            });
            return result;
        })
        .catch((err) => {
            console.error('[範本投影] 查詢 recurring_transactions 失敗:', err.message);
            return result;
        });
}

// 單一帳戶版本
function getProjectedTemplateRows(db, account, todayStr, maxDateStr) {
    if (!account || !account.account_name) return Promise.resolve([]);
    return getProjectedTemplateRowsByAccount(db, [account], todayStr, maxDateStr)
        .then((map) => map.get(account.id) || []);
}

module.exports = { getProjectedTemplateRows, getProjectedTemplateRowsByAccount, projectTemplateOccurrences };
