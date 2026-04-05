const { db } = require('../database/db');
const logger = require('./logger');

// 更新銀行帳戶的即時餘額
// 根據最近的餘額結算記錄 + 結算日～「當天」的收支記錄計算（即時餘額只統計到當天）
async function updateBankAccountBalance(accountName, accountNumber = null, companyName = null) {
    return new Promise((resolve, reject) => {
        if (!accountName) {
            return resolve();
        }
        const today = new Date().toISOString().split('T')[0];

        let accountQuery, accountParams;
        if (companyName) {
            accountQuery = `
                SELECT ba.id, ? as resolved_company FROM bank_accounts ba
                INNER JOIN companies c ON ba.company_id = c.id
                WHERE c.name = ? AND ba.account_name = ? AND ba.is_active = 1
                ${accountNumber ? 'AND (ba.account_number = ? OR ba.account_number IS NULL)' : ''}
            `;
            accountParams = accountNumber ? [companyName, companyName, accountName, accountNumber] : [companyName, companyName, accountName];
        } else {
            accountQuery = `
                SELECT ba.id, c.name as resolved_company FROM bank_accounts ba
                LEFT JOIN companies c ON ba.company_id = c.id
                WHERE ba.account_name = ? AND ba.is_active = 1
                ${accountNumber ? 'AND (ba.account_number = ? OR ba.account_number IS NULL)' : ''}
                LIMIT 1
            `;
            accountParams = accountNumber ? [accountName, accountNumber] : [accountName];
        }

        db.get(accountQuery, accountParams, (err, account) => {
            if (err) {
                logger.error('查詢銀行帳戶錯誤:', err);
                return reject(err);
            }

            if (!account) {
                return resolve();
            }

            const resolvedCompany = companyName || account.resolved_company || null;

            const settleWhere = resolvedCompany
                ? 'company_name = ? AND account_name = ? ' + (accountNumber ? 'AND (account_number = ? OR account_number IS NULL)' : '')
                : 'account_name = ? ' + (accountNumber ? 'AND account_number = ?' : '');
            const settleParams = resolvedCompany
                ? (accountNumber ? [resolvedCompany, accountName, accountNumber] : [resolvedCompany, accountName])
                : (accountNumber ? [accountName, accountNumber] : [accountName]);

            db.get(
                `SELECT settlement_date, actual_balance 
                 FROM balance_settlements 
                 WHERE ${settleWhere}
                 ORDER BY settlement_date DESC 
                 LIMIT 1`,
                settleParams,
                (err, settlement) => {
                    if (err) {
                        logger.error('查詢餘額結算錯誤:', err);
                        return reject(err);
                    }

                    let startBalance = 0;
                    let startDate = '1900-01-01';
                    if (settlement) {
                        startBalance = parseFloat(settlement.actual_balance) || 0;
                        startDate = settlement.settlement_date;
                    }

                    const transWhere = resolvedCompany
                        ? '(company_name = ? OR company_name IS NULL) AND account_name = ? AND transaction_date >= ? AND transaction_date <= ? ' + (accountNumber ? 'AND (account_number = ? OR account_number IS NULL)' : '')
                        : 'account_name = ? AND transaction_date >= ? AND transaction_date <= ? ' + (accountNumber ? 'AND account_number = ?' : '');
                    const transParams = resolvedCompany
                        ? (accountNumber ? [resolvedCompany, accountName, startDate, today, accountNumber] : [resolvedCompany, accountName, startDate, today])
                        : (accountNumber ? [accountName, startDate, today, accountNumber] : [accountName, startDate, today]);

                    const transQuery = `
                        SELECT type, SUM(amount) as total
                        FROM transactions
                        WHERE ${transWhere}
                        GROUP BY type
                    `;

                    db.all(transQuery, transParams, (err, transactions) => {
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
                                logger.info(`✓ 已更新帳戶 ${accountName} 的即時餘額: ${currentBalance}`);
                                resolve();
                            }
                        );
                    });
                }
            );
        });
    });
}

module.exports = { updateBankAccountBalance };
