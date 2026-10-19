// 新增一筆還款記錄，並在必要時同步借款主檔的「下次還款日」。
// 這段邏輯原本寫在 routes/financing.js 的 POST /:id/repayments 裡；抽成共用
// 函式，讓「週期性收支範本」產生連結借款的還款時也能呼叫同一套同步邏輯，
// 不用維護兩份。

const { addMonthsClamped } = require('./financingProjection');
const { addDaysStr } = require('./dateUtil');
const { MATCH_DAYS } = require('./financingSchedule');

const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

/**
 * @param {object} db sqlite3 database instance
 * @param {number} financingId
 * @param {object} repayment { payment_date, principal_paid, interest_paid, remarks }
 * @returns {Promise<{ repaymentId: number }>}
 */
function recordRepaymentAndSync(db, financingId, { payment_date, principal_paid, interest_paid, remarks }) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, facility_name, next_payment_date, repayment_frequency FROM financing WHERE id = ?',
            [financingId],
            (err, financingRow) => {
                if (err) return reject(err);
                if (!financingRow) return reject(new Error('找不到借款記錄'));

                db.run(
                    `INSERT INTO financing_repayments (financing_id, payment_date, principal_paid, interest_paid, remarks)
                     VALUES (?, ?, ?, ?, ?)`,
                    [financingId, payment_date, principal_paid || 0, interest_paid || 0, remarks || null],
                    function (insertErr) {
                        if (insertErr) return reject(insertErr);
                        const repaymentId = this.lastID;

                        // 這筆還款涵蓋了原本排定的「下次還款日」（或更晚），自動把排程同步
                        // 過去，避免忘記手動更新、讓資金流水帳/資金缺口繼續投影一筆其實已經
                        // 繳過的款項。補登較早日期的歷史資料（payment_date 早於
                        // next_payment_date）則不動，避免誤動到目前排定的下一筆。
                        if (financingRow.next_payment_date && payment_date >= financingRow.next_payment_date) {
                            let newNextDate = null;
                            if (financingRow.repayment_frequency === 'monthly' || financingRow.repayment_frequency === 'quarterly') {
                                const stepMonths = financingRow.repayment_frequency === 'quarterly' ? 3 : 1;
                                let cursor = financingRow.next_payment_date;
                                let guard = 0;
                                while (cursor <= payment_date && guard < 60) {
                                    cursor = addMonthsClamped(cursor, stepMonths);
                                    guard++;
                                }
                                newNextDate = cursor;
                            }
                            const syncSql = newNextDate
                                ? 'UPDATE financing SET next_payment_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                                : 'UPDATE financing SET next_payment_date = NULL, next_payment_amount = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
                            const syncParams = newNextDate ? [newNextDate, financingId] : [financingId];
                            db.run(syncSql, syncParams, (syncErr) => {
                                if (syncErr) console.error('同步下次還款日失敗:', syncErr.message);
                                resolve({ repaymentId, facilityName: financingRow.facility_name });
                            });
                        } else {
                            resolve({ repaymentId, facilityName: financingRow.facility_name });
                        }
                    }
                );
            }
        );
    });
}

/**
 * 在「借款管理」直接登記還款時，把連結這筆借款的週期範本也往後推（跟借款自己的「下次還款日」同步），
 * 否則範本還停在這一期，資金流水帳會把已經繳掉的這一期再預測一次（週期範本「產生下一筆」本身已經會推範本，不要呼叫這個）。
 *
 * 規則：
 * - 只有這筆借款「剛好一個」啟用中、有下次產生日的連結範本才處理；兩個以上無法判斷是哪一個，不動，回報讓使用者自己確認。
 * - 還款日距離範本下次產生日 20 天內（含更早／更晚），或已超過產生日，才視為繳了那一期；補登很久以前的歷史還款不動。
 * - 還款日已經超過後面幾期的產生日就連續往後推；推到超過範本到期日則清空並停用（跟「產生下一筆」一致）。
 * @returns {Promise<{ advanced: [{id, name, from, to, deactivated}] , skippedMultiple: boolean }>}
 */
function advanceLinkedTemplates(db, financingId, paymentDate) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT id, description, category, frequency, next_run_date, end_date FROM recurring_transactions WHERE financing_id = ? AND is_active = 1 AND next_run_date IS NOT NULL',
            [financingId],
            (err, templates) => {
                if (err) return reject(err);
                if (!templates.length) return resolve({ advanced: [], skippedMultiple: false });
                if (templates.length > 1) return resolve({ advanced: [], skippedMultiple: true });
                const t = templates[0];
                if (paymentDate < addDaysStr(t.next_run_date, -MATCH_DAYS)) return resolve({ advanced: [], skippedMultiple: false });
                const step = STEP_MONTHS[t.frequency] || 1;
                let cursor = addMonthsClamped(t.next_run_date, step);
                let guard = 0;
                while (cursor <= paymentDate && guard < 60) { cursor = addMonthsClamped(cursor, step); guard++; }
                const deactivated = !!(t.end_date && cursor > t.end_date);
                const sql = deactivated
                    ? 'UPDATE recurring_transactions SET next_run_date = NULL, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                    : 'UPDATE recurring_transactions SET next_run_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
                db.run(sql, deactivated ? [t.id] : [cursor, t.id], (updErr) => {
                    if (updErr) return reject(updErr);
                    resolve({ advanced: [{ id: t.id, name: t.description || t.category || '週期範本', from: t.next_run_date, to: deactivated ? null : cursor, deactivated }], skippedMultiple: false });
                });
            }
        );
    });
}

module.exports = { recordRepaymentAndSync, advanceLinkedTemplates };
