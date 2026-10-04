// 「貼上匯入」收支記錄的後端驗證與寫入。
//
// 前端已經在瀏覽器裡即時解析並顯示預覽，但伺服器不能信任前端：這裡對每一列重新驗證
// （日期、類型、金額、帳戶是否存在且唯一），整批「全有或全無」——任何一列有錯就整批不寫入。
// 寫入用單一 INSERT ... SELECT json_each(?)：一個 SQL 敘述本身就是原子的，不需要另外 BEGIN/COMMIT，
// 也就不會讓共用的 SQLite 連線在 transaction 期間夾進其他請求的查詢。

const { db } = require('../database/db');

const MAX_ROWS = 1000;
const MAX_TEXT = 500;
const MAX_AMOUNT = 1e12;

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));
}

function isValidDate(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function text(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
}

// 驗證並正規化每一列。回傳 { rows: [{ index, errors, normalized }], hasError }
async function validateRows(rawRows) {
    const accounts = await dbAll(
        `SELECT ba.account_name, ba.account_number, c.name AS company_name
         FROM bank_accounts ba LEFT JOIN companies c ON ba.company_id = c.id
         WHERE ba.is_active = 1`
    );
    const results = rawRows.map((raw, index) => {
        const errors = [];
        const r = raw && typeof raw === 'object' ? raw : {};
        const date = text(r.transaction_date);
        if (!isValidDate(date)) errors.push('日期格式不正確');

        const type = text(r.type);
        if (type !== 'income' && type !== 'expense') errors.push('類型必須是收入或支出');

        const amount = typeof r.amount === 'number' ? r.amount : Number(text(r.amount));
        if (!Number.isFinite(amount) || amount <= 0) errors.push('金額必須是大於 0 的數字');
        else if (amount > MAX_AMOUNT) errors.push('金額過大');

        const category = text(r.category), description = text(r.description), remarks = text(r.remarks);
        if (category.length > MAX_TEXT || description.length > MAX_TEXT || remarks.length > MAX_TEXT) {
            errors.push(`文字欄位不可超過 ${MAX_TEXT} 字`);
        }

        let companyName = text(r.company_name);
        const accountName = text(r.account_name);
        let accountNumber = text(r.account_number);
        if (accountName) {
            const matches = accounts.filter((a) =>
                a.account_name === accountName
                && (!companyName || (a.company_name || '') === companyName)
                && (!accountNumber || (a.account_number || '') === accountNumber));
            if (matches.length === 0) errors.push(`找不到帳戶「${accountName}」`);
            else if (matches.length > 1) errors.push(`有多個同名帳戶「${accountName}」，請一併指定公司或帳號`);
            else {
                companyName = matches[0].company_name || '';
                accountNumber = matches[0].account_number || '';
            }
        } else {
            accountNumber = '';
        }

        return {
            index,
            errors,
            normalized: {
                transaction_date: date,
                type,
                amount: Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null,
                category: category || null,
                description: description || null,
                company_name: companyName || null,
                account_name: accountName || null,
                account_number: accountNumber || null,
                remarks: remarks || null
            }
        };
    });
    return { rows: results, hasError: results.some((r) => r.errors.length > 0) };
}

// 找出資料庫已有「同日期、類型、金額、帳戶、說明」的列（疑似重複貼上）。回傳 index 陣列
async function findDuplicates(normalizedRows) {
    if (normalizedRows.length === 0) return [];
    const payload = JSON.stringify(normalizedRows.map((n) => ({
        d: n.transaction_date, t: n.type, a: n.amount,
        c: n.company_name || '', n: n.account_name || '', u: n.account_number || '', s: n.description || ''
    })));
    const rows = await dbAll(
        `SELECT j.key AS idx FROM json_each(?) j
         WHERE EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.transaction_date = json_extract(j.value, '$.d')
              AND t.type = json_extract(j.value, '$.t')
              AND ABS(t.amount - json_extract(j.value, '$.a')) < 0.005
              AND IFNULL(t.company_name, '') = json_extract(j.value, '$.c')
              AND IFNULL(t.account_name, '') = json_extract(j.value, '$.n')
              AND IFNULL(t.account_number, '') = json_extract(j.value, '$.u')
              AND IFNULL(t.description, '') = json_extract(j.value, '$.s')
         )`,
        [payload]
    );
    return rows.map((r) => Number(r.idx));
}

// 單一敘述寫入整批；回傳 { firstId, lastId }
async function insertRows(normalizedRows) {
    const payload = JSON.stringify(normalizedRows);
    const result = await dbRun(
        `INSERT INTO transactions
            (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks)
         SELECT json_extract(value, '$.transaction_date'), json_extract(value, '$.type'), json_extract(value, '$.amount'),
                json_extract(value, '$.category'), json_extract(value, '$.description'), json_extract(value, '$.company_name'),
                json_extract(value, '$.account_name'), json_extract(value, '$.account_number'), json_extract(value, '$.remarks')
         FROM json_each(?)`,
        [payload]
    );
    return { firstId: result.lastID - normalizedRows.length + 1, lastId: result.lastID };
}

module.exports = { validateRows, findDuplicates, insertRows, MAX_ROWS };
