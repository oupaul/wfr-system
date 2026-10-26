// 批次修改多筆收支記錄的日期：預覽（buildPlan）與套用（applyPlan）共用同一套規劃邏輯。
// 套用時伺服器會重新規劃一次，不信任前端送來的預覽結果。
//
// 規則：
// - 兩種方式：set＝全部改成指定日期；shift＝全部順延 N 天（可負數）。
// - 轉帳（兩腿共用 transfer_group_id）只要勾到任何一腿，另一腿一定一起改（auto_included），
//   兩腿日期必須一致，否則兩個帳戶的餘額會對不上。
// - 以單一 SQL UPDATE 寫入（全有或全無）；每個受影響的帳戶只重算一次餘額。
// - 每一筆都寫操作日誌（原日期 → 新日期）。
const { db } = require('../database/db');
const { addDaysStr, todayInTaipei } = require('./dateUtil');
const { getImpactContext, evaluateImpact, updateBankAccountBalance } = require('./bankAccountBalance');
const { writeOperationLog } = require('./operationLog');
const { norm } = require('./accountMatch');

const MAX_SELECTED = 500;       // 單次最多勾選幾筆
const MAX_ROWS = 1000;          // 含轉帳另一腿後的上限
const MAX_SHIFT_DAYS = 3660;    // 順延天數上限（約 10 年）

const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this); }));
const userError = (msg) => Object.assign(new Error(msg), { userError: true });

function isValidDate(str) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str || '')) return false;
    const d = new Date(`${str}T00:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

function validateInput({ ids, mode, date, days }) {
    if (!Array.isArray(ids) || ids.length === 0) throw userError('請先勾選要修改日期的記錄');
    const numericIds = [...new Set(ids.map((x) => parseInt(x, 10)).filter(Number.isFinite))];
    if (!numericIds.length) throw userError('ids 格式錯誤');
    if (numericIds.length > MAX_SELECTED) throw userError(`一次最多修改 ${MAX_SELECTED} 筆，請分批處理（目前勾選 ${numericIds.length} 筆）`);
    if (mode === 'set') {
        if (!isValidDate(date)) throw userError('請填寫正確的新日期（YYYY-MM-DD）');
        return { numericIds, mode, date };
    }
    if (mode === 'shift') {
        const n = Number(days);
        if (!Number.isInteger(n) || n === 0) throw userError('順延天數必須是不為 0 的整數（往前填負數）');
        if (Math.abs(n) > MAX_SHIFT_DAYS) throw userError(`順延天數不可超過 ${MAX_SHIFT_DAYS} 天`);
        return { numericIds, mode, days: n };
    }
    throw userError('mode 必須是 set（改成指定日期）或 shift（順延天數）');
}

/** @returns { rows: [...], summary: {...}, changedIds: number[] } */
async function buildPlan(input) {
    const v = validateInput(input);
    const ph = (a) => a.map(() => '?').join(',');
    const selected = await dbAll(`SELECT * FROM transactions WHERE id IN (${ph(v.numericIds)})`, v.numericIds);
    if (selected.length !== v.numericIds.length) {
        const found = new Set(selected.map((r) => r.id));
        throw userError(`找不到記錄 #${v.numericIds.filter((i) => !found.has(i)).slice(0, 5).join('、#')}（可能已被刪除，請重新整理）`);
    }

    // 轉帳另一腿一併帶入
    const selectedIds = new Set(selected.map((r) => r.id));
    const groupIds = [...new Set(selected.map((r) => r.transfer_group_id).filter(Boolean))];
    const siblings = groupIds.length
        ? (await dbAll(`SELECT * FROM transactions WHERE transfer_group_id IN (${ph(groupIds)})`, groupIds)).filter((r) => !selectedIds.has(r.id))
        : [];
    const all = [...selected.map((r) => ({ r, auto: false })), ...siblings.map((r) => ({ r, auto: true }))];
    if (all.length > MAX_ROWS) throw userError(`含轉帳另一腿共 ${all.length} 筆，超過單次上限 ${MAX_ROWS} 筆，請分批處理`);

    const today = todayInTaipei();
    const newDateOf = (old) => (v.mode === 'set' ? v.date : addDaysStr(old, v.days));

    // 每個帳戶只查一次（對應銀行帳戶＋最近結算日）
    const ctxCache = new Map();
    const ctxOf = async (r) => {
        const key = `${norm(r.company_name)}\u0001${norm(r.account_name)}\u0001${norm(r.account_number)}`;
        if (!ctxCache.has(key)) ctxCache.set(key, r.account_name ? await getImpactContext(r) : { found: false, account_id: null, settlement_date: null });
        return ctxCache.get(key);
    };

    // 可能對應借款還款記錄的收支：同日期、同金額（收支與還款記錄之間沒有關聯欄位，只能這樣比對）
    const oldDates = [...new Set(all.map(({ r }) => r.transaction_date))];
    const repayments = oldDates.length
        ? await dbAll(
            `SELECT fr.id, fr.payment_date, fr.principal_paid + fr.interest_paid AS total, f.facility_name
             FROM financing_repayments fr JOIN financing f ON f.id = fr.financing_id
             WHERE fr.payment_date IN (${ph(oldDates)})`, oldDates)
        : [];

    const rows = [];
    for (const { r, auto } of all) {
        const newDate = newDateOf(r.transaction_date);
        const changed = newDate !== r.transaction_date;
        const ctx = await ctxOf(r);
        const oldEffect = evaluateImpact(ctx, r.transaction_date, today);
        const newEffect = evaluateImpact(ctx, newDate, today);
        const warnings = [];
        if (changed) {
            if (newEffect.reason_code === 'before_settlement') warnings.push({ code: 'before_settlement', text: newEffect.reason });
            else if (newEffect.reason_code === 'future') warnings.push({ code: 'future', text: newEffect.reason });
            else if (newEffect.reason_code === 'no_account') warnings.push({ code: 'no_account', text: newEffect.reason });
            if (oldEffect.counted !== newEffect.counted && newEffect.reason_code !== 'no_account') {
                warnings.push({ code: 'balance_change', text: newEffect.counted ? '改日期後會開始影響目前餘額' : '改日期後不再影響目前餘額' });
            }
            if (r.type === 'expense') {
                const m = repayments.find((x) => x.payment_date === r.transaction_date && Math.abs(Number(x.total) - Number(r.amount)) < 0.01);
                if (m) warnings.push({ code: 'loan_repayment', text: `可能對應借款「${m.facility_name}」的還款記錄（${m.payment_date}），借款那邊的還款日期不會跟著變` });
            }
        }
        rows.push({
            id: r.id, old_date: r.transaction_date, new_date: newDate, changed, auto_included: auto,
            type: r.type, amount: r.amount, category: r.category, description: r.description,
            company_name: r.company_name, account_name: r.account_name, account_number: r.account_number,
            transfer_group_id: r.transfer_group_id || null, warnings
        });
    }
    rows.sort((a, b) => a.old_date.localeCompare(b.old_date) || a.id - b.id);

    const changedRows = rows.filter((x) => x.changed);
    const countCode = (c) => changedRows.filter((x) => x.warnings.some((w) => w.code === c)).length;
    const accounts = new Set(changedRows.filter((x) => x.account_name).map((x) => `${norm(x.company_name)}|${x.account_name}|${norm(x.account_number)}`));
    const newDates = changedRows.map((x) => x.new_date).sort();
    return {
        rows,
        changedIds: changedRows.map((x) => x.id),
        summary: {
            selected: v.numericIds.length, total: rows.length, changed: changedRows.length, unchanged: rows.length - changedRows.length,
            auto_included: rows.filter((x) => x.auto_included).length,
            accounts: accounts.size,
            new_date_min: newDates[0] || null, new_date_max: newDates[newDates.length - 1] || null,
            before_settlement: countCode('before_settlement'), future: countCode('future'), balance_change: countCode('balance_change'),
            loan_repayment: countCode('loan_repayment'), no_account: countCode('no_account')
        },
        input: v
    };
}

/** 套用：重新規劃後以單一 UPDATE 寫入，回傳 { updated, accounts, summary } */
async function applyPlan(req, input, expectedChanged = null) {
    const plan = await buildPlan(input);
    if (plan.changedIds.length === 0) throw userError('沒有任何一筆的日期會改變（新日期與原日期相同）');
    if (expectedChanged !== null && Number(expectedChanged) !== plan.changedIds.length) {
        throw Object.assign(new Error(`資料在你預覽之後有變動（預覽 ${expectedChanged} 筆、現在 ${plan.changedIds.length} 筆會改變），請重新預覽再確認`), { userError: true, conflict: true });
    }
    const ids = plan.changedIds;
    const ph = ids.map(() => '?').join(',');
    let result;
    if (plan.input.mode === 'set') {
        result = await dbRun(`UPDATE transactions SET transaction_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`, [plan.input.date, ...ids]);
    } else {
        const mod = `${plan.input.days > 0 ? '+' : '-'}${Math.abs(plan.input.days)} days`;
        result = await dbRun(`UPDATE transactions SET transaction_date = date(transaction_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`, [mod, ...ids]);
    }

    const changedRows = plan.rows.filter((x) => x.changed);
    changedRows.forEach((x) => {
        writeOperationLog(req, 'update', 'transaction', x.id, { transaction_date: x.old_date }, { transaction_date: x.new_date },
            `收支記錄 #${x.id} 批次修改日期 ${x.old_date} → ${x.new_date}${x.auto_included ? '（轉帳另一腿連動）' : ''}`);
    });

    // 受影響的帳戶（舊、新日期同一個帳戶）各重算一次餘額
    const distinct = new Map();
    changedRows.forEach((x) => { if (x.account_name) distinct.set(`${norm(x.company_name)}|${x.account_name}|${norm(x.account_number)}`, x); });
    for (const a of distinct.values()) {
        try { await updateBankAccountBalance(a.account_name, a.account_number, a.company_name || null); } catch (e) { /* 餘額快取失敗不影響已寫入的日期，之後重算會補上 */ }
    }
    return { updated: result.changes, accounts: distinct.size, summary: plan.summary };
}

module.exports = { buildPlan, applyPlan, MAX_SELECTED, MAX_ROWS, isValidDate };
