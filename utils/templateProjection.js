// 把啟用中的「週期範本」投影成未來的收支事件，併入資金流水帳／資金缺口的預測。
//
// 範本金額通常是預估值，真正發生時使用者會在「產生下一筆」確認視窗輸入實際金額，
// 所以這裡投影出來的列一律標成「（預計）」；按下產生後範本的下次產生日會往後推，
// 那一筆就變成真實交易，不會重複計算。
//
// - 已逾期（下次產生日 < 今天）還沒產生的期數全部落在「今天」，避免資金缺口被低估
// - 連結借款的範本不投影：借款本身已經由 utils/financingProjection.js 投影過同一筆還款
// - 超過 end_date 的期數不投影

const { addMonthsClamped } = require('./financingProjection');
const { transactionBelongsToAccount } = require('./accountMatch');

const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const MAX_OCCURRENCES = 60;

function projectTemplateOccurrences(template, todayStr, maxDateStr) {
    if (!template || !template.next_run_date || !template.is_active || template.financing_id) return [];
    const amount = parseFloat(template.amount) || 0;
    if (amount <= 0) return [];

    const stepMonths = STEP_MONTHS[template.frequency] || 1;
    const baseLabel = template.description || template.category || '週期範本';
    const occurrences = [];
    let cursor = template.next_run_date;
    let iterations = 0;

    while (iterations < MAX_OCCURRENCES) {
        if (template.end_date && cursor > template.end_date) break;
        const isOverdue = cursor < todayStr;
        const eventDate = isOverdue ? todayStr : cursor;
        if (eventDate > maxDateStr) break;
        occurrences.push({
            transaction_date: eventDate,
            type: template.type,
            amount,
            description: `（預計${isOverdue ? '・已逾期未確認' : ''}）${baseLabel}`,
            is_projected: true
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
    return new Promise((resolve) => {
        const result = new Map();
        (accounts || []).forEach((a) => result.set(a.id, []));
        db.all(
            `SELECT * FROM recurring_transactions
             WHERE is_active = 1 AND next_run_date IS NOT NULL AND financing_id IS NULL`,
            [],
            (err, templates) => {
                if (err) {
                    console.error('[範本投影] 查詢 recurring_transactions 失敗:', err.message);
                    return resolve(result);
                }
                (accounts || []).forEach((account) => {
                    (templates || []).forEach((t) => {
                        if (transactionBelongsToAccount(t, account)) {
                            result.get(account.id).push(...projectTemplateOccurrences(t, todayStr, maxDateStr));
                        }
                    });
                });
                resolve(result);
            }
        );
    });
}

// 單一帳戶版本
function getProjectedTemplateRows(db, account, todayStr, maxDateStr) {
    if (!account || !account.account_name) return Promise.resolve([]);
    return getProjectedTemplateRowsByAccount(db, [account], todayStr, maxDateStr)
        .then((map) => map.get(account.id) || []);
}

module.exports = { getProjectedTemplateRows, getProjectedTemplateRowsByAccount, projectTemplateOccurrences };
