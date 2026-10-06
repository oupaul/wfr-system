// 帳戶間轉帳：一次寫入兩筆收支記錄（轉出帳戶支出 + 轉入帳戶收入），共用同一個 transfer_group_id，
// 讓 /api/transactions/statistics 可以把它們排除在真正的營業收支統計之外。
// 「帳戶間轉帳」「轉定存」「定存解約」共用這一支，確保三者行為一致。
const crypto = require('crypto');
const { db } = require('../database/db');
const logger = require('./logger');
const { writeOperationLog } = require('./operationLog');
const { updateBankAccountBalance } = require('./bankAccountBalance');

function insertLeg(row) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO transactions
             (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks, transfer_group_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.date, row.type, row.amount, row.category, row.description,
             row.company_name || null, row.account_name || null, row.account_number || null, row.remarks || null, row.groupId],
            function (err) {
                if (err) return reject(err);
                resolve(this.lastID);
            }
        );
    });
}

/**
 * @param req 用來寫操作日誌（取使用者）
 * @param opts { date, amount, from, to, category, remarks, fromDescription, toDescription }
 *   from / to: { company_name, account_name, account_number }
 * @returns { fromId, toId, transferGroupId }；轉入那一腿失敗會撤銷轉出那一腿再丟出錯誤
 */
async function createTransfer(req, opts) {
    const { date, amount, from, to, remarks } = opts;
    const category = opts.category || '轉帳';
    const fromDescription = opts.fromDescription || `轉帳至 ${to.account_name}`;
    const toDescription = opts.toDescription || `轉帳自 ${from.account_name}`;
    const groupId = crypto.randomUUID();

    let fromId = null;
    try {
        fromId = await insertLeg({ date, type: 'expense', amount, category, description: fromDescription, ...from, remarks, groupId });
        const toId = await insertLeg({ date, type: 'income', amount, category, description: toDescription, ...to, remarks, groupId });

        const after = (id, type, acc) => ({
            id, transaction_date: date, type, amount, category,
            company_name: acc.company_name || null, account_name: acc.account_name,
            account_number: acc.account_number || null, transfer_group_id: groupId
        });
        writeOperationLog(req, 'create', 'transaction', fromId, null, after(fromId, 'expense', from), `轉帳 #${fromId} 轉出 ${from.account_name} → ${to.account_name}`);
        writeOperationLog(req, 'create', 'transaction', toId, null, after(toId, 'income', to), `轉帳 #${toId} 轉入 ${to.account_name} ← ${from.account_name}`);

        try {
            await updateBankAccountBalance(from.account_name, from.account_number, from.company_name || null);
            await updateBankAccountBalance(to.account_name, to.account_number, to.company_name || null);
        } catch (balanceErr) {
            logger.error('更新帳戶餘額失敗:', balanceErr);
        }
        return { fromId, toId, transferGroupId: groupId };
    } catch (err) {
        // 轉出那一腿成功、轉入那一腿失敗的話要撤銷，避免留下只扣款沒入帳的孤兒交易
        if (fromId) {
            db.run('DELETE FROM transactions WHERE id = ?', [fromId], (delErr) => {
                if (delErr) logger.error('回滾轉帳記錄失敗，交易 #' + fromId + ' 可能殘留，請手動檢查:', delErr);
            });
        }
        throw err;
    }
}

module.exports = { createTransfer };
