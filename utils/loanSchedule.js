// 借款的預計還款排程：有啟用中的連結範本時以範本為準，沒有才用借款自己的下次還款日／金額／頻率。
// 資金預估週報（utils/cashGapData.js 走 financingProjection / templateProjection 兩條路徑）與統計報表、
// 預測狀態診斷（utils/projectionStatus.js）共用這個規則，三邊才不會對同一筆借款說法不一致。
const { projectRepaymentOccurrences } = require('./financingProjection');
const { projectTemplateOccurrences } = require('./templateProjection');

/**
 * @param loan 借款列（含 is_active、maturity_date、next_payment_*、repayment_frequency、facility_name）
 * @param linkedTemplates 連結這筆借款的「啟用中且有下次產生日」的範本
 * @param remaining 目前本金餘額
 * @param openPeriods 這筆借款計畫表「還沒還的期數」（utils/financingSchedule.js 的 loadLoanSchedules）；只有一個連結範本時才會採用
 * @returns { source: 'template' | 'loan', occurrences: [{ transaction_date, amount, ... }] }
 */
function projectLoanSchedule(loan, linkedTemplates, todayStr, maxDateStr, remaining, openPeriods = null) {
    if (linkedTemplates && linkedTemplates.length) {
        const loanInfo = { remaining, maturityDate: loan.maturity_date, isActive: loan.is_active, openPeriods: linkedTemplates.length === 1 ? openPeriods : null };
        const occurrences = linkedTemplates.flatMap((t) => projectTemplateOccurrences(t, todayStr, maxDateStr, loanInfo));
        return { source: 'template', occurrences };
    }
    return { source: 'loan', occurrences: projectRepaymentOccurrences(loan, todayStr, maxDateStr, remaining) };
}

module.exports = { projectLoanSchedule };
