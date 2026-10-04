const { db } = require('../database/db');
const logger = require('./logger');
const { getLatestSettlement } = require('./settlementLookup');
const { todayInTaipei } = require('./dateUtil');
const { norm, transactionAccountSql } = require('./accountMatch');

// 更新銀行帳戶的即時餘額
// 根據最近的餘額結算記錄 + 結算日～「今天」（台北時區）的收支記錄計算（即時餘額只統計到當天）。
// 哪些收支屬於這個帳戶，跟資金預估週報共用同一套嚴格比對規則（見 utils/accountMatch.js）；
// 呼叫端傳進來的公司/帳戶/帳號也必須能精確找到一個啟用中的銀行帳戶，否則不更新任何帳戶。
async function updateBankAccountBalance(accountName, accountNumber = null, companyName = null) {
    return new Promise((resolve, reject) => {
        if (!accountName) {
            return resolve();
        }
        const today = todayInTaipei();

        const accountQuery = `
            SELECT ba.id, c.name as company_name, ba.account_name, ba.account_number
            FROM bank_accounts ba
            LEFT JOIN companies c ON ba.company_id = c.id
            WHERE ba.account_name = ? AND IFNULL(c.name, '') = ? AND IFNULL(ba.account_number, '') = ?
              AND ba.is_active = 1
            LIMIT 1
        `;

        db.get(accountQuery, [accountName, norm(companyName), norm(accountNumber)], (err, account) => {
            if (err) {
                logger.error('查詢銀行帳戶錯誤:', err);
                return reject(err);
            }

            if (!account) {
                return resolve();
            }

            getLatestSettlement(db, {
                companyName: account.company_name || null,
                accountName: account.account_name,
                accountNumber: account.account_number || null
            })
                .then((settlement) => {
                    let startBalance = 0;
                    let startDate = '1900-01-01';
                    if (settlement) {
                        startBalance = parseFloat(settlement.actual_balance) || 0;
                        startDate = settlement.settlement_date;
                    }

                    const match = transactionAccountSql(account);
                    const transQuery = `
                        SELECT type, SUM(amount) as total
                        FROM transactions
                        WHERE ${match.sql} AND transaction_date >= ? AND transaction_date <= ?
                        GROUP BY type
                    `;

                    db.all(transQuery, [...match.params, startDate, today], (err, transactions) => {
                        if (err) {
                            logger.error('查詢交易記錄錯誤:', err);
                            return reject(err);
                        }

                        let currentBalance = startBalance;
                        (transactions || []).forEach(trans => {
                            const tot = parseFloat(trans.total) || 0;
                            if (trans.type === 'income') currentBalance += tot;
                            else if (trans.type === 'expense') currentBalance -= tot;
                        });

                        db.run(
                            'UPDATE bank_accounts SET current_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                            [currentBalance, account.id],
                            (err) => {
                                if (err) {
                                    logger.error('更新帳戶餘額錯誤:', err);
                                    return reject(err);
                                }
                                logger.info(`✓ 已更新帳戶 ${account.account_name} 的即時餘額: ${currentBalance}`);
                                resolve();
                            }
                        );
                    });
                })
                .catch(reject);
        });
    });
}

module.exports = { updateBankAccountBalance };
