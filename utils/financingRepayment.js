// 新增一筆還款記錄，並在必要時同步借款主檔的「下次還款日」。
// 這段邏輯原本寫在 routes/financing.js 的 POST /:id/repayments 裡；抽成共用
// 函式，讓「週期性收支範本」產生連結借款的還款時也能呼叫同一套同步邏輯，
// 不用維護兩份。

const { addMonthsClamped } = require('./financingProjection');

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

module.exports = { recordRepaymentAndSync };
