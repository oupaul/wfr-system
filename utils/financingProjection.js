// 把借款的「下次還款日/金額」投影成未來的還款事件，供資金流水帳（cash-gap-ledger）
// 與帳戶卡片（cash-gap-dashboard-by-dates）併入現金流預測使用。
//
// 只投影未來（含今天）的還款，不會把 financing_repayments 的歷史還款回填成流水帳
// 交易——避免跟使用者之後可能另外記錄的真實收支記錄重複計算。
//
// 投影金額不會超過目前實際剩餘本金（principal_amount - 已還本金總和）：本金已經
// 還清的借款完全不投影；還在還款中的借款，累加投影金額一旦會超過剩餘本金就停止
// 產生後續期數。這是把 next_payment_amount 整筆當本金處理的保守近似（實際還款
// 通常還含利息，真正能投影的期數可能更少），但已足以避免長期分期貸款被嚴重高估。

const MAX_OCCURRENCES = 60; // 安全上限（例如每月投影最多 5 年），避免資料異常造成無限迴圈

function toLocalDateStr(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
}

// 加 N 個月，月底日期自動夾到當月最後一天（例如 1/31 + 1 個月要落在 2/28，
// 而不是滾動到 3/3），跟 routes/cashGap.js 的 clampToMonth 邏輯一致
function addMonthsClamped(dateStr, months) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const targetMonthIndex = (m - 1) + months;
    const targetYear = y + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
    const day = Math.min(d, lastDayOfTargetMonth);
    return toLocalDateStr(new Date(targetYear, targetMonth, day));
}

/**
 * 把一筆借款投影成未來還款事件。
 * @param {object} loan { facility_name, next_payment_date, next_payment_amount, repayment_frequency, maturity_date }
 * @param {string} todayStr 今天日期（YYYY-MM-DD）
 * @param {string} maxDateStr 投影上限日期（YYYY-MM-DD），通常是預測窗口的最後一天
 * @param {number} remainingPrincipal 目前實際剩餘本金；<= 0 代表已還清，不投影
 * @returns {Array} 還款事件陣列
 */
function projectRepaymentOccurrences(loan, todayStr, maxDateStr, remainingPrincipal) {
    if (!loan || !loan.next_payment_date || loan.next_payment_amount == null || loan.next_payment_amount === '') {
        return [];
    }
    if (remainingPrincipal != null && remainingPrincipal <= 0) {
        return [];
    }

    const stepMonths = loan.repayment_frequency === 'quarterly' ? 3
        : (loan.repayment_frequency === 'monthly' ? 1 : null);

    let cursor = loan.next_payment_date;

    // 下次還款日已過期：有頻率就往後跳整數期到第一個 >= 今天的日期；
    // 沒有頻率就視為過期，不投影（維持既有「使用者自行維護 next_payment_date」
    // 的心智模型，只是現在這個欄位同時也決定了投影起點）
    if (stepMonths) {
        let guard = 0;
        while (cursor < todayStr && guard < MAX_OCCURRENCES) {
            cursor = addMonthsClamped(cursor, stepMonths);
            guard++;
        }
    }
    if (cursor < todayStr) return [];

    const amount = parseFloat(loan.next_payment_amount) || 0;
    if (amount <= 0) return [];

    const hasPrincipalCap = remainingPrincipal != null;
    const occurrences = [];
    let cumulative = 0;
    let iterations = 0;
    while (
        cursor <= maxDateStr &&
        (!loan.maturity_date || cursor <= loan.maturity_date) &&
        iterations < MAX_OCCURRENCES
    ) {
        if (hasPrincipalCap && cumulative + amount > remainingPrincipal) break;
        cumulative += amount;
        occurrences.push({
            transaction_date: cursor,
            type: 'expense',
            amount,
            description: `（預計）${loan.facility_name || '借款'} 還款`,
            is_projected: true
        });
        if (!stepMonths) break; // 不重複，只有這一筆
        cursor = addMonthsClamped(cursor, stepMonths);
        iterations++;
    }
    return occurrences;
}

/**
 * 查出某銀行帳戶關聯的所有啟用中借款，投影出未來還款事件。
 * 永遠 resolve（內部查詢失敗只記錄錯誤、回傳空陣列），呼叫端不需要另外處理
 * .catch，避免影響既有資金流水帳/帳戶卡片端點的錯誤處理路徑。
 */
function getProjectedRepaymentRows(db, bankAccountId, todayStr, maxDateStr) {
    return new Promise((resolve) => {
        if (!bankAccountId) return resolve([]);
        db.all(
            `SELECT f.facility_name, f.next_payment_date, f.next_payment_amount, f.repayment_frequency, f.maturity_date,
                    (f.principal_amount - COALESCE((
                        SELECT SUM(fr.principal_paid) FROM financing_repayments fr WHERE fr.financing_id = f.id
                    ), 0)) as remaining_principal
             FROM financing f
             WHERE f.bank_account_id = ? AND f.is_active = 1`,
            [bankAccountId],
            (err, loans) => {
                if (err) {
                    console.error('[借款投影] 查詢 financing 失敗:', err.message);
                    return resolve([]);
                }
                const rows = [];
                (loans || []).forEach((loan) => {
                    rows.push(...projectRepaymentOccurrences(loan, todayStr, maxDateStr, loan.remaining_principal));
                });
                resolve(rows);
            }
        );
    });
}

module.exports = { getProjectedRepaymentRows, projectRepaymentOccurrences, addMonthsClamped };
