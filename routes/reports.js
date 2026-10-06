// 統計報表 API：現金流走勢、月別收支與類別占比、借款與定存到期總表，以及 Excel 匯出。
// 開放給哪些角色由管理員設定（utils/reportAccess.js），預設只有管理員。
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');
const { writeOperationLog } = require('../utils/operationLog');
const { ACCESS_LEVELS, getReportsAccess, setReportsAccess, canViewReports } = require('../utils/reportAccess');
const { getCashflowReport, getIncomeExpenseReport, getDebtDepositReport } = require('../utils/reportData');
const { buildCashflowWorkbook, buildIncomeExpenseWorkbook, buildDebtDepositWorkbook } = require('../utils/reportExport');
const { todayInTaipei } = require('../utils/dateUtil');

const requireReportAccess = async (req, res, next) => {
    const access = await getReportsAccess();
    if (req.session && req.session.userId && canViewReports(req.session.role, access)) return next();
    return res.status(403).json({ error: '您沒有檢視統計報表的權限，請洽管理員', authenticated: false });
};

// 目前的開放範圍與目前使用者是否可看（任何登入者都可以查詢自己的狀態）
router.get('/settings', async (req, res) => {
    const access = await getReportsAccess();
    res.json({ access, can_view: canViewReports(req.session.role, access), is_admin: req.session.role === 'admin' });
});

router.put('/settings', requireAdmin, async (req, res) => {
    const { access } = req.body || {};
    if (!ACCESS_LEVELS.includes(access)) return res.status(400).json({ error: '開放範圍不正確' });
    try {
        const before = await getReportsAccess();
        await setReportsAccess(access);
        const labels = { admin: '僅管理員', finance: '管理員與財務人員', all: '所有登入人員' };
        writeOperationLog(req, 'update', 'system_settings', 'reports_access', { access: before }, { access },
            `統計報表開放範圍：${labels[before]} → ${labels[access]}`);
        res.json({ success: true, access });
    } catch (err) {
        logger.error('儲存報表開放範圍錯誤:', err);
        res.status(500).json({ error: '儲存失敗' });
    }
});

const intParam = (v, def, min, max) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const dateParam = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : undefined);
const companyParam = (v) => (v && /^\d+$/.test(String(v)) ? parseInt(v, 10) : undefined);

function cashflowParams(q) {
    return {
        companyId: companyParam(q.company_id),
        scope: q.scope === 'all' ? 'all' : 'available',
        monthsBack: intParam(q.months_back, 6, 0, 24),
        monthsAhead: intParam(q.months_ahead, 12, 1, 24)
    };
}
const incomeExpenseParams = (q) => ({ start: dateParam(q.start), end: dateParam(q.end), companyId: companyParam(q.company_id) });
const debtDepositParams = (q) => ({ companyId: companyParam(q.company_id) });

const wrap = (fn) => async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        res.json(await fn(req));
    } catch (err) {
        logger.error('統計報表錯誤:', err);
        res.status(500).json({ error: '報表產生失敗', details: err.message });
    }
};

router.get('/cashflow', requireReportAccess, wrap((req) => getCashflowReport(cashflowParams(req.query))));
router.get('/income-expense', requireReportAccess, wrap((req) => getIncomeExpenseReport(incomeExpenseParams(req.query))));
router.get('/debt-deposit', requireReportAccess, wrap((req) => getDebtDepositReport(debtDepositParams(req.query))));

const EXPORTS = {
    'cashflow': { name: '現金流走勢', load: (q) => getCashflowReport(cashflowParams(q)), build: buildCashflowWorkbook },
    'income-expense': { name: '月別收支與類別占比', load: (q) => getIncomeExpenseReport(incomeExpenseParams(q)), build: buildIncomeExpenseWorkbook },
    'debt-deposit': { name: '借款與定存到期總表', load: (q) => getDebtDepositReport(debtDepositParams(q)), build: buildDebtDepositWorkbook }
};

router.get('/export/:kind', requireReportAccess, async (req, res) => {
    const def = EXPORTS[req.params.kind];
    if (!def) return res.status(404).json({ error: '找不到這份報表' });
    try {
        const data = await def.load(req.query);
        const workbook = def.build(data);
        const fileName = `資金週報_${def.name}_${todayInTaipei()}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        await workbook.xlsx.write(res);
        res.end();
        writeOperationLog(req, 'create', 'report_export', req.params.kind, null, { report: def.name }, `匯出報表：${def.name}`);
    } catch (err) {
        logger.error('匯出報表錯誤:', err);
        if (!res.headersSent) res.status(500).json({ error: '匯出失敗', details: err.message });
    }
});

module.exports = router;
