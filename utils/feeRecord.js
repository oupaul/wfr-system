// 銀行手續費：記成一般的「手續費」支出（扣款帳戶、銀行實際扣款日），不併入轉帳群組。
// 轉帳（含轉定存、解約）兩腿是「帳戶間搬錢」，不計入收入／支出統計；手續費是真的花掉的錢，
// 必須是獨立的一筆支出，統計報表才看得到。類別固定「手續費」，報表才會歸成同一類。
const { db } = require('../database/db');
const logger = require('./logger');
const { writeOperationLog } = require('./operationLog');
const { updateBankAccountBalance } = require('./bankAccountBalance');

const FEE_CATEGORY = '手續費';
const MAX_FEE = 100000; // 單筆手續費上限，避免把轉帳金額誤填進手續費欄

/** 表單的手續費欄：空白視為 0；回傳 { amount } 或 { error } */
function parseFee(value) {
    if (value === undefined || value === null || value === '') return { amount: 0 };
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return { error: '手續費必須是大於或等於 0 的數字' };
    if (n > MAX_FEE) return { error: `手續費不可超過 ${MAX_FEE.toLocaleString('en-US')} 元（金額很大請確認是不是填錯欄位）` };
    return { amount: Math.round(n * 100) / 100 };
}

/**
 * @param opts { date, amount, account: { company_name, account_name, account_number }, description, remarks }
 * @returns transaction id
 */
async function recordFee(req, { date, amount, account, description, remarks }) {
    const id = await new Promise((resolve, reject) => db.run(
        `INSERT INTO transactions (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks)
         VALUES (?, 'expense', ?, ?, ?, ?, ?, ?, ?)`,
        [date, amount, FEE_CATEGORY, description, account.company_name || null, account.account_name, account.account_number || null, remarks || null],
        function (err) { return err ? reject(err) : resolve(this.lastID); }));
    writeOperationLog(req, 'create', 'transaction', id, null,
        { id, transaction_date: date, type: 'expense', amount, category: FEE_CATEGORY, account_name: account.account_name },
        `手續費 #${id} ${account.account_name} ${amount}（${description}）`);
    try {
        await updateBankAccountBalance(account.account_name, account.account_number || null, account.company_name || null);
    } catch (e) {
        logger.error('手續費記錄後更新帳戶餘額失敗:', e);
    }
    return id;
}

module.exports = { FEE_CATEGORY, MAX_FEE, parseFee, recordFee };
