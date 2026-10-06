// 統計報表匯出成 Excel（.xlsx）：每份報表一個活頁簿、多張工作表，格式比照系統配色
// （表頭深藍黑 #1E293B 白字、金額千分位、凍結首列）。
const ExcelJS = require('exceljs');

const HEADER_FILL = 'FF1E293B';
const NUM_FMT = '#,##0;[Red]-#,##0';
const PCT_FMT = '0.0%';

function newSheet(workbook, name, titleLines, columns) {
    const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: titleLines.length + 1 }] });
    titleLines.forEach((line, i) => {
        ws.getCell(i + 1, 1).value = line;
        ws.getCell(i + 1, 1).font = i === 0 ? { bold: true, size: 14 } : { color: { argb: 'FF64748B' } };
    });
    const headerRow = ws.getRow(titleLines.length + 1);
    columns.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.header;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        cell.alignment = { vertical: 'middle', horizontal: col.numeric ? 'right' : 'left' };
        ws.getColumn(i + 1).width = col.width || 14;
    });
    ws._cols = columns;
    return ws;
}

function addRow(ws, values, opts = {}) {
    const row = ws.addRow(values);
    ws._cols.forEach((col, i) => {
        const cell = row.getCell(i + 1);
        if (col.numeric) {
            cell.numFmt = col.percent ? PCT_FMT : NUM_FMT;
            cell.alignment = { horizontal: 'right' };
        }
        if (opts.bold) cell.font = { bold: true };
    });
    if (opts.bold) row.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } } }; });
    return row;
}

const typeLabel = { past: '實際', today: '今天', future: '預測' };
const scopeLabel = { available: '可用資金（活存＋定存）', all: '全部帳戶' };

function buildCashflowWorkbook(data) {
    const wb = new ExcelJS.Workbook();
    const cols = [
        { header: '日期', width: 13 }, { header: '期間', width: 11 }, { header: '類型', width: 9 },
        { header: '餘額合計', width: 16, numeric: true },
        ...data.companies.map((c) => ({ header: c, width: 16, numeric: true })),
        { header: '安全水位合計', width: 16, numeric: true }, { header: '與安全水位差額', width: 16, numeric: true }
    ];
    const ws = newSheet(wb, '現金流走勢', [
        '現金流走勢（月底餘額）',
        `範圍：${scopeLabel[data.scope] || data.scope}　公司：${data.company || '全部公司'}　產生日期：${data.today}`,
        '實際＝過去月底與今天的餘額；預測＝含借款還款、週期範本、定存到期的預計事件。'
    ], cols);
    data.points.forEach((p) => {
        addRow(ws, [p.date, p.label, typeLabel[p.kind], p.total, ...data.companies.map((c) => p.byCompany[c] || 0),
            data.safety_level_total, p.total - data.safety_level_total]);
    });
    return wb;
}

function buildIncomeExpenseWorkbook(data) {
    const wb = new ExcelJS.Workbook();
    const title = (name) => [`${name}`, `期間：${data.start} ～ ${data.end}　公司：${data.company || '全部公司'}（已排除帳戶間轉帳）`];
    const monthly = newSheet(wb, '月別收支', title('月別收支'), [
        { header: '月份', width: 11 }, { header: '收入', width: 15, numeric: true }, { header: '支出', width: 15, numeric: true },
        { header: '淨收支', width: 15, numeric: true }, { header: '筆數', width: 9, numeric: true }
    ]);
    data.months.forEach((m) => addRow(monthly, [m.month, m.income, m.expense, m.net, m.count]));
    addRow(monthly, ['合計', data.totals.income, data.totals.expense, data.totals.net, data.months.reduce((s, m) => s + m.count, 0)], { bold: true });

    const catCols = [{ header: '類別', width: 22 }, { header: '金額', width: 16, numeric: true },
        { header: '占比', width: 9, numeric: true, percent: true }, { header: '筆數', width: 9, numeric: true }];
    const exp = newSheet(wb, '支出類別', title('支出類別占比'), catCols);
    data.expense_categories.forEach((c) => addRow(exp, [c.category, c.total, c.percent, c.count]));
    const inc = newSheet(wb, '收入類別', title('收入類別占比'), catCols);
    data.income_categories.forEach((c) => addRow(inc, [c.category, c.total, c.percent, c.count]));

    const topCols = [{ header: '日期', width: 12 }, { header: '金額', width: 15, numeric: true }, { header: '類別', width: 16 },
        { header: '說明', width: 36 }, { header: '公司', width: 18 }, { header: '帳戶', width: 20 }];
    const addTop = (name, rows) => {
        const ws = newSheet(wb, name, title(name), topCols);
        rows.forEach((r) => addRow(ws, [r.transaction_date, r.amount, r.category || '', r.description || '', r.company_name || '', r.account_name || '']));
    };
    addTop('最大支出前10', data.top_expenses);
    addTop('最大收入前10', data.top_incomes);
    return wb;
}

function buildDebtDepositWorkbook(data) {
    const wb = new ExcelJS.Workbook();
    const sub = `公司：${data.company || '全部公司'}　產生日期：${data.today}`;
    const loans = newSheet(wb, '借款明細', ['借款與融資明細（啟用中、尚有本金餘額）', sub], [
        { header: '公司', width: 16 }, { header: '借款/額度', width: 24 }, { header: '類型', width: 11 }, { header: '貸款機構', width: 16 },
        { header: '目前本金餘額', width: 16, numeric: true }, { header: '總額度', width: 15, numeric: true },
        { header: '額度使用率', width: 11, numeric: true, percent: true }, { header: '年利率(%)', width: 10, numeric: true },
        { header: '到期日', width: 12 }, { header: '距到期(天)', width: 11, numeric: true },
        { header: '下次還款日', width: 12 }, { header: '下次還款金額', width: 14, numeric: true }
    ]);
    data.loans.forEach((l) => addRow(loans, [l.company_name, l.facility_name, l.facility_type || '', l.lender || '', l.remaining_principal,
        l.total_limit, l.usage_rate, l.interest_rate == null ? null : Number(l.interest_rate), l.maturity_date || '', l.days_to_maturity,
        l.next_payment_date || '', l.next_payment_amount == null ? null : Number(l.next_payment_amount)]));
    addRow(loans, ['合計', '', '', '', data.loan_total], { bold: true });

    const sched = newSheet(wb, '未來12個月還款', ['未來 12 個月預計還款與預估利息', sub,
        '預計還款＝借款管理的下次還款設定投影；預估利息＝月初本金餘額×年利率÷12（參考，已含在還款金額內，不另外加總）'], [
        { header: '月份', width: 11 }, { header: '預計還款', width: 16, numeric: true }, { header: '預估利息（參考）', width: 18, numeric: true }]);
    data.monthly.forEach((m) => addRow(sched, [m.month, m.repayment, m.interest_estimate]));
    addRow(sched, ['合計', data.monthly.reduce((s, m) => s + m.repayment, 0), data.monthly.reduce((s, m) => s + m.interest_estimate, 0)], { bold: true });

    const paid = newSheet(wb, '近12個月已付', ['近 12 個月實際已付本金與利息（還款記錄）', sub], [
        { header: '月份', width: 11 }, { header: '已付本金', width: 16, numeric: true }, { header: '已付利息', width: 16, numeric: true }]);
    data.paid.forEach((r) => addRow(paid, [r.month, r.principal, r.interest]));
    addRow(paid, ['合計', data.paid_totals.principal, data.paid_totals.interest], { bold: true });

    const dep = newSheet(wb, '定存明細', ['定存明細（餘額大於 0）', sub], [
        { header: '公司', width: 16 }, { header: '銀行', width: 16 }, { header: '帳戶', width: 24 }, { header: '餘額', width: 16, numeric: true },
        { header: '年利率(%)', width: 10, numeric: true }, { header: '起存日', width: 12 }, { header: '到期日', width: 12 },
        { header: '距到期(天)', width: 11, numeric: true }, { header: '預估到期利息', width: 15, numeric: true },
        { header: '狀態', width: 14 }, { header: '到期轉回', width: 20 }]);
    data.deposits.forEach((d) => addRow(dep, [d.company_name, d.bank_name, d.account_name, d.balance,
        d.interest_rate == null ? null : Number(d.interest_rate), d.start_date || '', d.maturity_date || '', d.days_left,
        d.interest_estimate, d.status, d.return_account || '']));
    addRow(dep, ['合計', '', '', data.deposit_total, '', '', '', '', data.deposit_interest_estimate_total], { bold: true });

    const buckets = newSheet(wb, '定存到期分布', ['定存到期分布', sub], [
        { header: '區間', width: 16 }, { header: '金額', width: 16, numeric: true }, { header: '筆數', width: 9, numeric: true }]);
    data.deposit_buckets.forEach((b) => addRow(buckets, [b.label, b.amount, b.count]));
    return wb;
}

module.exports = { buildCashflowWorkbook, buildIncomeExpenseWorkbook, buildDebtDepositWorkbook };
