// 統計報表的資料計算：現金流走勢、月別收支與類別占比、借款與定存到期總表。
// 餘額、預計事件一律沿用資金預估週報的同一套邏輯與載入函式（utils/cashGapData.js），
// 所以報表上的「目前餘額」「預計餘額」跟週報、銀行帳戶頁的數字一致。

const { dbAll, loadActiveAccounts, loadAccountInputs, loadProjectedFutureRows } = require('./cashGapData');
const { transactionBelongsToAccount } = require('./accountMatch');
const { todayInTaipei, addDaysStr } = require('./dateUtil');
const { REMAINING_PRINCIPAL_SQL, projectRepaymentOccurrences } = require('./financingProjection');
const { estimateInterest, daysBetween } = require('./deposit');

const AVAILABLE_TYPES = ['活存', '定存']; // 跟週報「可用資金」同一個範圍

function pad(n) { return String(n).padStart(2, '0'); }

function monthEnd(year, monthIndex) {
    const last = new Date(year, monthIndex + 1, 0).getDate();
    return `${year}-${pad(monthIndex + 1)}-${pad(last)}`;
}

// 從 todayStr 所在月份往前／往後各 N 個月，回傳每月的月底日期（含 YYYY-MM 標籤）
function monthEndPoints(todayStr, monthsBack, monthsAhead) {
    const [y, m] = todayStr.split('-').map(Number);
    const out = [];
    for (let k = -monthsBack; k <= monthsAhead; k++) {
        const idx = (m - 1) + k;
        const year = y + Math.floor(idx / 12);
        const month = ((idx % 12) + 12) % 12;
        out.push({ date: monthEnd(year, month), month: `${year}-${pad(month + 1)}` });
    }
    return out;
}

async function getCompanyName(companyId) {
    if (!companyId) return null;
    const rows = await dbAll('SELECT name FROM companies WHERE id = ?', [companyId]);
    return rows[0] ? rows[0].name : null;
}

// ==================== 1. 現金流走勢 ====================
// 每個月底的餘額（過去為實際、未來為預測），以及今天的餘額。
// 餘額的起算點與週報相同：各帳戶「最近一次結算」。結算日之前的月份，用「結算金額往回扣掉結算日前的收支」推算。
async function getCashflowReport({ companyId, scope = 'available', monthsBack = 6, monthsAhead = 12 }) {
    const today = todayInTaipei();
    let accounts = await loadActiveAccounts();
    const companyName = await getCompanyName(companyId);
    if (companyId) accounts = accounts.filter((a) => Number(a.company_id) === Number(companyId));
    if (scope === 'available') accounts = accounts.filter((a) => AVAILABLE_TYPES.includes(a.account_type));

    const monthPoints = monthEndPoints(today, monthsBack, monthsAhead);
    const maxDate = monthPoints[monthPoints.length - 1].date;
    const firstDate = monthPoints[0].date;

    const empty = { today, scope, company: companyName, points: [], companies: [], safety_level_total: 0, summary: null };
    if (accounts.length === 0) return empty;

    const inputsPromise = loadAccountInputs(accounts, maxDate);
    const [inputs, projections] = await Promise.all([inputsPromise, loadProjectedFutureRows(accounts, today, maxDate, inputsPromise)]);

    // 結算日「之前」的歷史收支（只有最早的圖表點早於某帳戶結算日時才需要）
    const maxStart = accounts.reduce((m, a) => (inputs.get(a.id).startDate > m ? inputs.get(a.id).startDate : m), '0000-00-00');
    const history = new Map(accounts.map((a) => [a.id, []]));
    if (firstDate < maxStart) {
        const names = [...new Set(accounts.map((a) => a.account_name).filter(Boolean))];
        const rows = await dbAll(
            `SELECT transaction_date, type, amount, company_name, account_name, account_number
             FROM transactions WHERE account_name IN (${names.map(() => '?').join(',')})
               AND transaction_date > ? AND transaction_date < ?`,
            [...names, firstDate, maxStart]
        );
        accounts.forEach((a) => {
            const startDate = inputs.get(a.id).startDate;
            history.set(a.id, rows.filter((t) => transactionBelongsToAccount(t, a) && t.transaction_date < startDate));
        });
    }

    const signed = (t) => (t.type === 'income' ? 1 : -1) * (parseFloat(t.amount) || 0);
    const balanceAt = (account, dateStr) => {
        const input = inputs.get(account.id);
        if (dateStr >= input.startDate) {
            let b = input.openingBalance;
            input.rows.forEach((t) => { if (t.transaction_date <= dateStr) b += signed(t); });
            // 預計事件（借款還款、週期範本、定存到期）只算在「今天之後」的點；今天與過去的點是實際餘額，
            // 跟週報、銀行帳戶頁的「目前餘額」一致
            if (dateStr > today) (projections.get(account.id) || []).forEach((t) => { if (t.transaction_date <= dateStr) b += signed(t); });
            return b;
        }
        // 結算日之前：結算日當天開始時的餘額 − 這段期間（dateStr 之後、結算日之前）的收支
        let b = input.openingBalance;
        history.get(account.id).forEach((t) => { if (t.transaction_date > dateStr) b -= signed(t); });
        return b;
    };

    const companies = [...new Set(accounts.map((a) => a.company_name || '未分類'))];
    const makePoint = (date, label, kind) => {
        const byCompany = {};
        companies.forEach((c) => { byCompany[c] = 0; });
        let total = 0;
        accounts.forEach((a) => {
            const b = balanceAt(a, date);
            total += b;
            byCompany[a.company_name || '未分類'] += b;
        });
        return { date, label, kind, total, byCompany };
    };

    const points = [];
    monthPoints.forEach((mp) => {
        // 當月月底還沒到，是預測；今天另外加一個點
        points.push(makePoint(mp.date, mp.month, mp.date < today ? 'past' : 'future'));
    });
    points.push(makePoint(today, '今天', 'today'));
    points.sort((a, b) => (a.date === b.date ? (a.kind === 'today' ? -1 : 1) : a.date.localeCompare(b.date)));

    const safetyTotal = accounts.reduce((s, a) => s + (parseFloat(a.safety_level) || 0), 0);
    const future = points.filter((p) => p.date >= today);
    const lowest = future.reduce((m, p) => (m === null || p.total < m.total ? p : m), null);
    const todayPoint = points.find((p) => p.kind === 'today');
    return {
        today, scope, company: companyName, points, companies,
        safety_level_total: safetyTotal,
        summary: {
            current_total: todayPoint ? todayPoint.total : 0,
            lowest_future: lowest ? { date: lowest.date, total: lowest.total } : null,
            below_safety: safetyTotal > 0 && lowest ? lowest.total < safetyTotal : false,
            account_count: accounts.length
        }
    };
}

// ==================== 2. 月別收支與類別占比 ====================
async function getIncomeExpenseReport({ start, end, companyId }) {
    const today = todayInTaipei();
    const defaultStart = `${monthEndPoints(today, 11, 0)[0].month}-01`; // 預設含當月共 12 個月
    const s = start || defaultStart;
    const e = end || today;
    const companyName = await getCompanyName(companyId);

    // 帳戶間轉帳（transfer_group_id 不為 NULL）不是營業收支，一律排除
    let where = 'transfer_group_id IS NULL AND transaction_date >= ? AND transaction_date <= ?';
    const params = [s, e];
    if (companyName) { where += ' AND company_name = ?'; params.push(companyName); }

    const monthlyRows = await dbAll(
        `SELECT substr(transaction_date, 1, 7) AS month, type, SUM(amount) AS total, COUNT(*) AS cnt
         FROM transactions WHERE ${where} GROUP BY month, type ORDER BY month`, params);
    const months = [];
    const byMonth = new Map();
    // 補滿期間內每個月（沒有交易的月份顯示 0）
    let [cy, cm] = s.split('-').map(Number);
    const [ey, em] = e.split('-').map(Number);
    while (cy < ey || (cy === ey && cm <= em)) {
        const key = `${cy}-${pad(cm)}`;
        const row = { month: key, income: 0, expense: 0, net: 0, count: 0 };
        byMonth.set(key, row); months.push(row);
        cm++; if (cm > 12) { cm = 1; cy++; }
    }
    monthlyRows.forEach((r) => {
        const row = byMonth.get(r.month);
        if (!row) return;
        row[r.type] = r.total || 0;
        row.count += r.cnt;
    });
    months.forEach((m) => { m.net = m.income - m.expense; });
    const totals = months.reduce((t, m) => ({ income: t.income + m.income, expense: t.expense + m.expense }), { income: 0, expense: 0 });
    totals.net = totals.income - totals.expense;

    const catRows = await dbAll(
        `SELECT IFNULL(NULLIF(TRIM(category), ''), '未分類') AS category, type, SUM(amount) AS total, COUNT(*) AS cnt
         FROM transactions WHERE ${where} GROUP BY category, type ORDER BY total DESC`, params);
    const toCategories = (type, sum) => catRows.filter((r) => r.type === type).map((r) => ({
        category: r.category, total: r.total || 0, count: r.cnt, percent: sum > 0 ? (r.total || 0) / sum : 0
    }));

    const topOf = (type) => dbAll(
        `SELECT transaction_date, description, category, company_name, account_name, amount
         FROM transactions WHERE ${where} AND type = ? ORDER BY amount DESC, transaction_date DESC LIMIT 10`, [...params, type]);

    return {
        start: s, end: e, company: companyName, months, totals,
        expense_categories: toCategories('expense', totals.expense),
        income_categories: toCategories('income', totals.income),
        top_expenses: await topOf('expense'),
        top_incomes: await topOf('income')
    };
}

// ==================== 3. 借款與定存到期總表 ====================
async function getDebtDepositReport({ companyId }) {
    const today = todayInTaipei();
    const companyName = await getCompanyName(companyId);
    const [ty, tm] = today.split('-').map(Number);
    const horizon = monthEndPoints(today, 0, 11); // 當月起 12 個月
    const maxDate = horizon[horizon.length - 1].date;

    // ---- 借款 ----
    const loanRows = await dbAll(`
        SELECT f.*, c.name AS company_name, MAX(0, ${REMAINING_PRINCIPAL_SQL}) AS remaining_principal
        FROM financing f LEFT JOIN companies c ON f.company_id = c.id
        WHERE f.is_active = 1 ${companyId ? 'AND f.company_id = ?' : ''}
        ORDER BY f.maturity_date IS NULL, f.maturity_date, f.facility_name`, companyId ? [companyId] : []);
    const loans = loanRows.filter((l) => (parseFloat(l.remaining_principal) || 0) > 0).map((l) => {
        const daysToMaturity = l.maturity_date ? daysBetween(today, l.maturity_date) * (l.maturity_date < today ? -1 : 1) : null;
        const limit = parseFloat(l.total_limit) || 0;
        return {
            id: l.id, company_name: l.company_name || '未分類', facility_name: l.facility_name, facility_type: l.facility_type,
            lender: l.lender, remaining_principal: parseFloat(l.remaining_principal) || 0,
            principal_amount: parseFloat(l.principal_amount) || 0, total_limit: limit || null,
            usage_rate: limit > 0 ? (parseFloat(l.remaining_principal) || 0) / limit : null,
            interest_rate: l.interest_rate, maturity_date: l.maturity_date, days_to_maturity: daysToMaturity,
            next_payment_date: l.next_payment_date, next_payment_amount: l.next_payment_amount,
            repayment_frequency: l.repayment_frequency,
            maturing_soon: daysToMaturity !== null && daysToMaturity <= 90
        };
    });
    const loanTotal = loans.reduce((s, l) => s + l.remaining_principal, 0);

    // 未來 12 個月預計還款（跟資金流水帳投影同一個函式）與預估利息（參考）
    const monthly = horizon.map((h) => ({ month: h.month, repayment: 0, interest_estimate: 0 }));
    const idxOf = new Map(monthly.map((m, i) => [m.month, i]));
    loans.forEach((l) => {
        const source = loanRows.find((r) => r.id === l.id);
        const occ = projectRepaymentOccurrences(source, today, maxDate, l.remaining_principal);
        const perMonth = new Map();
        occ.forEach((o) => {
            const key = o.transaction_date.slice(0, 7);
            perMonth.set(key, (perMonth.get(key) || 0) + o.amount);
            if (idxOf.has(key)) monthly[idxOf.get(key)].repayment += o.amount;
        });
        // 預估利息：月初本金餘額 × 年利率 ÷ 12；還款金額一律視為還本金（跟還款投影的保守近似一致）
        let balance = l.remaining_principal;
        const rate = parseFloat(l.interest_rate) || 0;
        monthly.forEach((m) => {
            if (rate > 0 && balance > 0) m.interest_estimate += balance * rate / 100 / 12;
            balance = Math.max(0, balance - (perMonth.get(m.month) || 0));
        });
    });
    monthly.forEach((m) => { m.interest_estimate = Math.round(m.interest_estimate); });

    // 近 12 個月實際已付本金／利息（還款記錄）
    const sinceStr = `${ty - 1}-${pad(tm)}-01`;
    const paidRows = await dbAll(`
        SELECT substr(fr.payment_date, 1, 7) AS month, SUM(fr.principal_paid) AS principal, SUM(fr.interest_paid) AS interest
        FROM financing_repayments fr JOIN financing f ON f.id = fr.financing_id
        WHERE fr.payment_date >= ? AND fr.payment_date <= ? ${companyId ? 'AND f.company_id = ?' : ''}
        GROUP BY month ORDER BY month`, companyId ? [sinceStr, today, companyId] : [sinceStr, today]);
    const paid = paidRows.map((r) => ({ month: r.month, principal: r.principal || 0, interest: r.interest || 0 }));
    const paidTotals = paid.reduce((t, r) => ({ principal: t.principal + r.principal, interest: t.interest + r.interest }), { principal: 0, interest: 0 });

    // ---- 定存 ----
    let accounts = (await loadActiveAccounts()).filter((a) => a.account_type === '定存');
    if (companyId) accounts = accounts.filter((a) => Number(a.company_id) === Number(companyId));
    const allAccounts = await loadActiveAccounts();
    const nameOf = new Map(allAccounts.map((a) => [a.id, a.account_name]));
    const deposits = [];
    if (accounts.length) {
        const inputs = await loadAccountInputs(accounts, today);
        accounts.forEach((a) => {
            const input = inputs.get(a.id);
            const balance = input.openingBalance + input.rows.reduce((b, t) => (t.transaction_date <= today ? b + (t.type === 'income' ? 1 : -1) * (parseFloat(t.amount) || 0) : b), 0);
            if (balance <= 0.005) return;
            const maturity = a.deposit_maturity_date || null;
            const daysLeft = maturity ? (maturity < today ? -daysBetween(maturity, today) : daysBetween(today, maturity)) : null;
            let status = '無到期日';
            if (maturity) status = maturity <= today ? '已到期未確認' : (daysLeft <= 30 ? '30 天內到期' : '進行中');
            deposits.push({
                id: a.id, company_name: a.company_name || '未分類', bank_name: a.bank_name || '', account_name: a.account_name,
                balance, interest_rate: a.deposit_interest_rate, start_date: a.deposit_start_date, maturity_date: maturity,
                days_left: daysLeft, status,
                interest_estimate: estimateInterest(balance, a.deposit_interest_rate, a.deposit_start_date, maturity),
                return_account: a.deposit_return_account_id ? (nameOf.get(a.deposit_return_account_id) || '') : ''
            });
        });
        deposits.sort((x, y) => (x.maturity_date || '9999').localeCompare(y.maturity_date || '9999'));
    }
    const depositTotal = deposits.reduce((s, d) => s + d.balance, 0);
    const buckets = [
        { label: '已到期未確認', amount: 0, count: 0 }, { label: '30 天內', amount: 0, count: 0 },
        { label: '31～90 天', amount: 0, count: 0 }, { label: '90 天以上', amount: 0, count: 0 }, { label: '未設定到期日', amount: 0, count: 0 }
    ];
    deposits.forEach((d) => {
        const i = d.maturity_date === null ? 4 : (d.status === '已到期未確認' ? 0 : (d.days_left <= 30 ? 1 : (d.days_left <= 90 ? 2 : 3)));
        buckets[i].amount += d.balance; buckets[i].count += 1;
    });
    const byBankMap = new Map();
    deposits.forEach((d) => {
        const key = `${d.company_name}｜${d.bank_name || '（未填銀行）'}`;
        byBankMap.set(key, (byBankMap.get(key) || 0) + d.balance);
    });
    const byBank = [...byBankMap.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);

    // 近 12 個月已實現的利息收入（定存解約時記錄的「利息收入」）
    const interestRows = await dbAll(
        `SELECT SUM(amount) AS total FROM transactions
         WHERE category = '利息收入' AND type = 'income' AND transaction_date >= ? AND transaction_date <= ?
         ${companyName ? 'AND company_name = ?' : ''}`, companyName ? [sinceStr, today, companyName] : [sinceStr, today]);

    return {
        today, company: companyName,
        loans, loan_total: loanTotal, monthly, paid, paid_totals: paidTotals,
        deposits, deposit_total: depositTotal, deposit_buckets: buckets, deposit_by_bank: byBank,
        interest_income_12m: (interestRows[0] && interestRows[0].total) || 0,
        deposit_interest_estimate_total: deposits.reduce((s, d) => s + d.interest_estimate, 0),
        coverage: loanTotal > 0 ? depositTotal / loanTotal : null
    };
}

module.exports = { getCashflowReport, getIncomeExpenseReport, getDebtDepositReport, AVAILABLE_TYPES };
