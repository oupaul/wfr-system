const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { requireEditor } = require('../middleware/auth');
const { todayInTaipei } = require('../utils/dateUtil');
const { balancesAfterEachRepayment } = require('../utils/financingBalance');
const { getLoanProjectionStatuses } = require('../utils/projectionStatus');
const { buildScheduleView, suggestForDate } = require('../utils/financingSchedule');
const { recordRepaymentAndSync, advanceLinkedTemplates } = require('../utils/financingRepayment');
const { REMAINING_PRINCIPAL_SQL } = require('../utils/financingProjection');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');

// 目前本金餘額的定義（含手動輸入餘額）集中在 utils/financingProjection.js，跟資金預估的投影上限共用

// 手動輸入的餘額與基準日只給有編輯權限者（admin/finance）；一般使用者的回應不帶這兩個欄位，
// 目前本金餘額（remaining_principal）的數字本身不受影響
function stripManualFieldsForViewer(req, rows) {
    if (req.session && (req.session.role === 'admin' || req.session.role === 'finance')) return rows;
    const strip = (r) => {
        if (!r) return r;
        const { manual_principal_balance, manual_balance_date, ...rest } = r;
        return rest;
    };
    return Array.isArray(rows) ? rows.map(strip) : strip(rows);
}

// 解析手動輸入的本金餘額：空值代表清除手動餘額（回到自動計算）；回傳 { value, error }
function parseManualBalance(raw) {
    if (raw === undefined || raw === null || raw === '') return { value: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { error: '目前本金餘額必須是大於或等於 0 的數字' };
    return { value: n };
}

// 換算成寫入用的 (餘額, 基準日)：餘額沒變就保留原本基準日，有變才把基準日更新成今天，
// 這樣編輯其他欄位不會不小心重設基準日、讓之前的還款被重複扣一次
function resolveManualBalance(newValue, oldRow) {
    if (newValue === null) return { balance: null, date: null };
    const unchanged = oldRow && oldRow.manual_principal_balance != null
        && Number(oldRow.manual_principal_balance) === newValue && oldRow.manual_balance_date;
    return { balance: newValue, date: unchanged ? oldRow.manual_balance_date : todayInTaipei() };
}

// 取得所有借款/融資額度
router.get('/', (req, res) => {
    const { company_id, active } = req.query;
    let query = `
        SELECT f.*, c.name as company_name, ba.account_name as bank_account_name,
               ba.bank_name as bank_account_bank_name,
               ${REMAINING_PRINCIPAL_SQL} as remaining_principal
        FROM financing f
        LEFT JOIN companies c ON f.company_id = c.id
        LEFT JOIN bank_accounts ba ON f.bank_account_id = ba.id
        WHERE 1=1
    `;
    const params = [];

    if (company_id) {
        query += ' AND f.company_id = ?';
        params.push(company_id);
    }
    if (active !== undefined) {
        query += ' AND f.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY f.is_active DESC, f.maturity_date IS NULL, f.maturity_date ASC';

    db.all(query, params, async (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        let data = stripManualFieldsForViewer(req, rows);
        // 預測狀態診斷（這筆借款有沒有被資金預測帶入、沒有的話原因）：只給管理員／財務人員
        const isEditor = req.session && (req.session.role === 'admin' || req.session.role === 'finance');
        if (isEditor && rows.length) {
            try {
                const statuses = await getLoanProjectionStatuses(rows.map((r) => r.id));
                // 連結的週期範本（還款建議從範本「確認本期入帳」操作，前端在還款記錄視窗提示）
                const linked = await new Promise((resolve, reject) => db.all(
                    `SELECT id, financing_id, description, category FROM recurring_transactions
                     WHERE is_active = 1 AND next_run_date IS NOT NULL AND financing_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`,
                    rows.map((r) => r.id), (e, r) => (e ? reject(e) : resolve(r || []))));
                const byLoan = new Map();
                linked.forEach((t) => { if (!byLoan.has(t.financing_id)) byLoan.set(t.financing_id, []); byLoan.get(t.financing_id).push(t); });
                data = data.map((r) => {
                    const ts = byLoan.get(r.id) || [];
                    return { ...r, projection_status: statuses.get(r.id) || null,
                        linked_template_count: ts.length, linked_template_id: ts.length ? ts[0].id : null,
                        linked_template_name: ts.length ? (ts[0].description || ts[0].category || '週期範本') : null };
                });
            } catch (statusErr) {
                logger.error('計算預測狀態失敗:', statusErr);
            }
        }
        res.json({ data, count: rows.length });
    });
});

// 取得單一借款/融資額度
router.get('/:id', (req, res) => {
    const { id } = req.params;
    db.get(
        `SELECT f.*, c.name as company_name, ba.account_name as bank_account_name,
                ba.bank_name as bank_account_bank_name,
                ${REMAINING_PRINCIPAL_SQL} as remaining_principal
         FROM financing f
         LEFT JOIN companies c ON f.company_id = c.id
         LEFT JOIN bank_accounts ba ON f.bank_account_id = ba.id
         WHERE f.id = ?`,
        [id],
        (err, row) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            res.json({ data: stripManualFieldsForViewer(req, row) });
        }
    );
});

// 新增借款/融資額度
router.post('/', requireEditor, (req, res) => {
    const {
        company_id, bank_account_id, facility_name, facility_type, lender,
        total_limit, principal_amount, interest_rate, start_date, maturity_date,
        repayment_method, next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active,
        manual_principal_balance
    } = req.body;

    if (!facility_name) {
        return res.status(400).json({ error: 'facility_name 為必填欄位' });
    }
    const manualParsed = parseManualBalance(manual_principal_balance);
    if (manualParsed.error) return res.status(400).json({ error: manualParsed.error });
    const manual = resolveManualBalance(manualParsed.value, null);

    db.run(
        `INSERT INTO financing
         (company_id, bank_account_id, facility_name, facility_type, lender, total_limit,
          principal_amount, interest_rate, start_date, maturity_date, repayment_method,
          next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active,
          manual_principal_balance, manual_balance_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            company_id || null, bank_account_id || null, facility_name, facility_type || '短期借款',
            lender || null, total_limit != null && total_limit !== '' ? total_limit : null,
            principal_amount || 0, interest_rate != null && interest_rate !== '' ? interest_rate : null,
            start_date || null, maturity_date || null, repayment_method || null,
            next_payment_date || null, next_payment_amount != null && next_payment_amount !== '' ? next_payment_amount : null,
            repayment_frequency || null,
            remarks || null, is_active !== undefined ? is_active : 1,
            manual.balance, manual.date
        ],
        function (err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, company_id: company_id || null, facility_name, facility_type: facility_type || '短期借款' };
            writeOperationLog(req, 'create', 'financing', newId, null, afterData, '借款/額度 #' + newId + ' ' + (facility_name || ''));
            res.json({ success: true, id: newId, message: '借款/額度已新增' });
        }
    );
});

// 更新借款/融資額度
router.put('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    const {
        company_id, bank_account_id, facility_name, facility_type, lender,
        total_limit, principal_amount, interest_rate, start_date, maturity_date,
        repayment_method, next_payment_date, next_payment_amount, repayment_frequency, remarks, is_active,
        manual_principal_balance
    } = req.body;

    if (!facility_name) {
        return res.status(400).json({ error: 'facility_name 為必填欄位' });
    }
    const manualParsed = parseManualBalance(manual_principal_balance);
    if (manualParsed.error) return res.status(400).json({ error: manualParsed.error });

    db.get('SELECT * FROM financing WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = {
            id: parseInt(id, 10), company_id: company_id || null, bank_account_id: bank_account_id || null,
            facility_name, facility_type: facility_type || '短期借款', lender: lender || null,
            total_limit: total_limit != null && total_limit !== '' ? total_limit : null,
            principal_amount: principal_amount || 0,
            interest_rate: interest_rate != null && interest_rate !== '' ? interest_rate : null,
            start_date: start_date || null, maturity_date: maturity_date || null,
            repayment_method: repayment_method || null, next_payment_date: next_payment_date || null,
            next_payment_amount: next_payment_amount != null && next_payment_amount !== '' ? next_payment_amount : null,
            repayment_frequency: repayment_frequency || null,
            remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1
        };
        const manual = resolveManualBalance(manualParsed.value, oldRow);
        afterData.manual_principal_balance = manual.balance;
        afterData.manual_balance_date = manual.date;
        db.run(
            `UPDATE financing SET company_id = ?, bank_account_id = ?, facility_name = ?, facility_type = ?,
                lender = ?, total_limit = ?, principal_amount = ?, interest_rate = ?, start_date = ?,
                maturity_date = ?, repayment_method = ?, next_payment_date = ?, next_payment_amount = ?,
                repayment_frequency = ?, remarks = ?, is_active = ?,
                manual_principal_balance = ?, manual_balance_date = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                afterData.company_id, afterData.bank_account_id, afterData.facility_name, afterData.facility_type,
                afterData.lender, afterData.total_limit, afterData.principal_amount, afterData.interest_rate,
                afterData.start_date, afterData.maturity_date, afterData.repayment_method,
                afterData.next_payment_date, afterData.next_payment_amount, afterData.repayment_frequency,
                afterData.remarks, afterData.is_active,
                manual.balance, manual.date,
                id
            ],
            function (updateErr) {
                if (updateErr) {
                    logger.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'financing', id, oldRow, afterData, '借款/額度 #' + id + ' ' + (facility_name || ''));
                res.json({ success: true, message: '借款/額度已更新' });
            }
        );
    });
});

// 刪除借款/融資額度（先刪還款記錄——這個專案沒有開啟 PRAGMA foreign_keys，
// ON DELETE CASCADE 不會真的生效，必須手動清掉子記錄）。刪除前也要檢查有沒有
// 週期性範本連結到這筆借款，比照銀行帳戶/公司刪除前檢查借款的做法。
router.delete('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM financing WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.all('SELECT description, category FROM recurring_transactions WHERE financing_id = ?', [id], (rtErr, rtRows) => {
            if (rtErr) {
                logger.error('查詢關聯範本錯誤:', rtErr);
                return res.status(500).json({ error: '刪除失敗', details: rtErr.message });
            }
            if (rtRows && rtRows.length > 0) {
                return res.status(400).json({
                    error: `此借款仍有 ${rtRows.length} 筆週期性範本連結，請先到「週期範本」頁面取消連結或刪除這些範本，再刪除此借款。`
                });
            }
            db.run('DELETE FROM financing_repayments WHERE financing_id = ?', [id], (repayDelErr) => {
                if (repayDelErr) {
                    logger.error('刪除還款記錄錯誤:', repayDelErr);
                    return res.status(500).json({ error: '刪除失敗', details: repayDelErr.message });
                }
                // 還款計畫表跟著借款一起刪（這個專案沒開外鍵，不會自動連動）
                db.run('DELETE FROM financing_schedule WHERE financing_id = ?', [id], (schedDelErr) => {
                    if (schedDelErr) logger.error('刪除還款計畫表錯誤:', schedDelErr);
                db.run('DELETE FROM financing WHERE id = ?', [id], function (delErr) {
                    if (delErr) {
                        logger.error('刪除錯誤:', delErr);
                        return res.status(500).json({ error: '刪除失敗', details: delErr.message });
                    }
                    if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                    writeOperationLog(req, 'delete', 'financing', id, row, null, '借款/額度 #' + id + ' ' + (row.facility_name || ''));
                    res.json({ success: true, message: '借款/額度已刪除' });
                });
                });
            });
        });
    });
});

// ==================== 還款記錄 ====================

// 取得某筆借款的還款歷史
router.get('/:id/repayments', (req, res) => {
    const { id } = req.params;
    db.get('SELECT principal_amount, manual_principal_balance, manual_balance_date FROM financing WHERE id = ?', [id], (finErr, fin) => {
        if (finErr) {
            logger.error('查詢借款錯誤:', finErr);
            return res.status(500).json({ error: '查詢失敗', details: finErr.message });
        }
        if (!fin) return res.status(404).json({ error: '找不到借款記錄' });
        db.all(
            'SELECT * FROM financing_repayments WHERE financing_id = ? ORDER BY payment_date DESC, id DESC',
            [id],
            (err, rows) => {
                if (err) {
                    logger.error('查詢還款記錄錯誤:', err);
                    return res.status(500).json({ error: '查詢失敗', details: err.message });
                }
                // 每一期「還款後的本金餘額」，供使用者逐期對照銀行對帳單
                const balances = balancesAfterEachRepayment(fin, rows);
                const today = todayInTaipei();
                // is_future：還款日期在未來（已排定、尚未發生），不計入目前本金餘額
                const data = rows.map((r) => ({ ...r, balance_after: balances.get(r.id), is_future: r.payment_date > today }));
                const interestTotal = rows.reduce((sum, r) => sum + (parseFloat(r.interest_paid) || 0), 0);
                res.json({ data, count: data.length, interest_total: interestTotal });
            }
        );
    });
});


// ==================== 還款計畫表 ====================
// 本息攤還／融資租賃等每期本金、利息都不同的借款，可貼上或匯入每期計畫；用途：核對目前本金餘額、帶入「產生下一筆」與新增還款的本金／利息。
// 計畫表只是參考資料，不會自動寫入任何收支或還款記錄。

const dbAllP = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, r) => (e ? reject(e) : resolve(r || []))));
const dbGetP = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
const dbRunP = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { return e ? reject(e) : resolve(this); }));

async function loadScheduleView(financingId) {
    const loan = await dbGetP(`SELECT f.id, f.facility_name, ${REMAINING_PRINCIPAL_SQL} AS remaining_principal FROM financing f WHERE f.id = ?`, [financingId]);
    if (!loan) return null;
    const periods = await dbAllP('SELECT * FROM financing_schedule WHERE financing_id = ? ORDER BY period_no', [financingId]);
    const repayments = await dbAllP('SELECT * FROM financing_repayments WHERE financing_id = ?', [financingId]);
    return { loan, view: buildScheduleView(loan, periods, repayments, todayInTaipei()) };
}

router.get('/:id/schedule', async (req, res) => {
    try {
        const r = await loadScheduleView(req.params.id);
        if (!r) return res.status(404).json({ error: '找不到借款記錄' });
        res.set('Cache-Control', 'no-store');
        res.json({ periods: r.view.periods, summary: r.view.summary });
    } catch (err) {
        logger.error('查詢還款計畫表錯誤:', err);
        res.status(500).json({ error: '查詢失敗', details: err.message });
    }
});

// 帶入建議：指定日期（預設今天）附近還沒有還款記錄的那一期
router.get('/:id/schedule/suggest', async (req, res) => {
    try {
        const r = await loadScheduleView(req.params.id);
        if (!r) return res.status(404).json({ error: '找不到借款記錄' });
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayInTaipei();
        res.set('Cache-Control', 'no-store');
        res.json({ suggestion: suggestForDate(r.view, date) });
    } catch (err) {
        logger.error('查詢還款計畫建議錯誤:', err);
        res.status(500).json({ error: '查詢失敗', details: err.message });
    }
});

// 匯入（覆蓋）整份計畫表：同期數更新、不在新資料裡的舊期數刪除
router.post('/:id/schedule', requireEditor, async (req, res) => {
    const { id } = req.params;
    const rows = req.body && req.body.periods;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: '沒有可匯入的計畫資料' });
    if (rows.length > 600) return res.status(400).json({ error: '計畫表最多 600 期' });

    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(`${v}T00:00:00Z`));
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const clean = [];
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const period = parseInt(r.period_no, 10);
        const principal = num(r.principal), interest = num(r.interest), fee = num(r.fee) ?? 0, balance = num(r.balance_after);
        const bad = (msg) => res.status(400).json({ error: `第 ${i + 1} 列：${msg}` });
        if (!Number.isInteger(period) || period < 1) return bad('期數必須是 1 以上的整數');
        if (seen.has(period)) return bad(`期數 ${period} 重複`);
        seen.add(period);
        if (!isDate(r.due_date)) return bad('日期格式不正確');
        if (!Number.isFinite(principal) || principal < 0) return bad('本金必須是大於或等於 0 的數字');
        if (!Number.isFinite(interest) || interest < 0) return bad('利息必須是大於或等於 0 的數字');
        if (!Number.isFinite(fee) || fee < 0) return bad('費用（營業稅等）必須是大於或等於 0 的數字');
        if (balance !== null && (!Number.isFinite(balance) || balance < 0)) return bad('本金餘額必須是大於或等於 0 的數字');
        clean.push({ period_no: period, due_date: r.due_date, principal, interest, fee, balance_after: balance });
    }
    try {
        const loan = await dbGetP('SELECT id, facility_name FROM financing WHERE id = ?', [id]);
        if (!loan) return res.status(404).json({ error: '找不到借款記錄' });
        const before = await dbGetP('SELECT COUNT(*) AS n FROM financing_schedule WHERE financing_id = ?', [id]);
        // 單一敘述寫入整批（同期數覆蓋），再刪掉不在新資料裡的舊期數
        await dbRunP(
            `INSERT INTO financing_schedule (financing_id, period_no, due_date, principal, interest, fee, balance_after)
             SELECT ?, json_extract(value, '$.period_no'), json_extract(value, '$.due_date'), json_extract(value, '$.principal'),
                    json_extract(value, '$.interest'), json_extract(value, '$.fee'), json_extract(value, '$.balance_after')
             FROM json_each(?) WHERE true
             ON CONFLICT(financing_id, period_no) DO UPDATE SET due_date = excluded.due_date, principal = excluded.principal,
                interest = excluded.interest, fee = excluded.fee, balance_after = excluded.balance_after`,
            [id, JSON.stringify(clean)]);
        await dbRunP(`DELETE FROM financing_schedule WHERE financing_id = ? AND period_no NOT IN (${clean.map(() => '?').join(',')})`,
            [id, ...clean.map((c) => c.period_no)]);
        writeOperationLog(req, 'update', 'financing_schedule', id, { periods: before.n }, { periods: clean.length },
            `借款 #${id}「${loan.facility_name}」匯入還款計畫表 ${clean.length} 期`);
        res.json({ success: true, count: clean.length, message: `已匯入 ${clean.length} 期還款計畫` });
    } catch (err) {
        logger.error('匯入還款計畫表錯誤:', err);
        res.status(500).json({ error: '匯入失敗', details: err.message });
    }
});

// 以指定日期的本金餘額校正目前本金餘額（還款計畫表核對用）：設成手動本金餘額，基準日＝指定日期（不能晚於今天）
router.post('/:id/calibrate-balance', requireEditor, async (req, res) => {
    const { id } = req.params;
    const balance = parseManualBalance(req.body.balance);
    const date = req.body.date;
    if (balance.error || balance.value === null) return res.status(400).json({ error: '本金餘額必須是大於或等於 0 的數字' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > todayInTaipei()) return res.status(400).json({ error: '基準日期格式不正確，且不可晚於今天' });
    try {
        const before = await dbGetP(`SELECT f.facility_name, f.manual_principal_balance, f.manual_balance_date, ${REMAINING_PRINCIPAL_SQL} AS remaining FROM financing f WHERE f.id = ?`, [id]);
        if (!before) return res.status(404).json({ error: '找不到借款記錄' });
        await dbRunP('UPDATE financing SET manual_principal_balance = ?, manual_balance_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [balance.value, date, id]);
        writeOperationLog(req, 'update', 'financing', id,
            { manual_principal_balance: before.manual_principal_balance, manual_balance_date: before.manual_balance_date, remaining: before.remaining },
            { manual_principal_balance: balance.value, manual_balance_date: date },
            `借款 #${id}「${before.facility_name}」依還款計畫表校正本金餘額：系統 ${Math.round(before.remaining)} → ${Math.round(balance.value)}（基準日 ${date}）`);
        res.json({ success: true, message: `已校正目前本金餘額為 ${Math.round(balance.value).toLocaleString('en-US')}（基準日 ${date}）` });
    } catch (err) {
        logger.error('校正本金餘額錯誤:', err);
        res.status(500).json({ error: '校正失敗', details: err.message });
    }
});

router.delete('/:id/schedule', requireEditor, async (req, res) => {
    try {
        const r = await dbRunP('DELETE FROM financing_schedule WHERE financing_id = ?', [req.params.id]);
        writeOperationLog(req, 'delete', 'financing_schedule', req.params.id, { periods: r.changes }, null, `借款 #${req.params.id} 清除還款計畫表（${r.changes} 期）`);
        res.json({ success: true, message: '還款計畫表已清除' });
    } catch (err) {
        logger.error('清除還款計畫表錯誤:', err);
        res.status(500).json({ error: '清除失敗', details: err.message });
    }
});

// 新增一筆還款記錄。
// 可選填 bank_principal_balance（銀行對帳單顯示的「這次還款後的本金餘額」）：填了就以銀行的數字為準，
// 把它登記成目前本金餘額（基準日＝這筆還款的日期），之後的還款再從這個數字往下扣，
// 同時回報「系統原本推算的餘額」與差額，讓使用者知道是不是前面某期本金／利息拆錯了。
router.post('/:id/repayments', requireEditor, async (req, res) => {
    const { id } = req.params;
    const { payment_date, principal_paid, interest_paid, remarks } = req.body;

    if (!payment_date) {
        return res.status(400).json({ error: 'payment_date 為必填欄位' });
    }
    const bankBalanceParsed = parseManualBalance(req.body.bank_principal_balance);
    if (bankBalanceParsed.error) {
        return res.status(400).json({ error: '銀行顯示的本金餘額必須是大於或等於 0 的數字' });
    }
    const bankBalance = bankBalanceParsed.value; // null = 沒填

    let transactionId = null;
    let financingAccount = null;

    try {
        financingAccount = await new Promise((resolve, reject) => {
            db.get(
                `SELECT f.facility_name, c.name as company_name, ba.account_name, ba.account_number
                 FROM financing f
                 LEFT JOIN companies c ON f.company_id = c.id
                 LEFT JOIN bank_accounts ba ON f.bank_account_id = ba.id
                 WHERE f.id = ?`,
                [id],
                (err, row) => (err ? reject(err) : resolve(row))
            );
        });
        if (!financingAccount) {
            return res.status(404).json({ error: '找不到借款記錄' });
        }

        const amount = (parseFloat(principal_paid) || 0) + (parseFloat(interest_paid) || 0);

        if (financingAccount.account_name && amount > 0) {
            transactionId = await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO transactions
                     (transaction_date, type, amount, description, company_name, account_name, account_number, remarks)
                     VALUES (?, 'expense', ?, ?, ?, ?, ?, ?)`,
                    [payment_date, amount, (financingAccount.facility_name || '借款') + ' 還款',
                     financingAccount.company_name || null, financingAccount.account_name,
                     financingAccount.account_number || null, remarks || null],
                    function (err) { err ? reject(err) : resolve(this.lastID); }
                );
            });
            try {
                await updateBankAccountBalance(financingAccount.account_name, financingAccount.account_number, financingAccount.company_name || null);
            } catch (balanceErr) {
                logger.error('更新帳戶餘額失敗:', balanceErr);
            }
        }

        const { repaymentId, facilityName } = await recordRepaymentAndSync(db, id, { payment_date, principal_paid, interest_paid, remarks });

        // 連結的週期範本也往後推，否則資金流水帳會把這一期已經繳掉的款再預測一次
        let templateSync = { advanced: [], skippedMultiple: false };
        try {
            templateSync = await advanceLinkedTemplates(db, id, payment_date);
            templateSync.advanced.forEach((a) => {
                writeOperationLog(req, 'update', 'recurring_transaction', a.id, { next_run_date: a.from }, { next_run_date: a.to, is_active: a.deactivated ? 0 : 1 },
                    `週期範本 #${a.id}「${a.name}」隨借款還款 #${repaymentId} 順延：下次產生日 ${a.from} → ${a.to || '（已到期停用）'}`);
            });
        } catch (syncErr) {
            logger.error('同步連結範本的下次產生日失敗（還款記錄已建立）:', syncErr);
        }

        if (transactionId) {
            writeOperationLog(req, 'create', 'transaction', transactionId, null,
                { id: transactionId, transaction_date: payment_date, type: 'expense', amount },
                '收支記錄 #' + transactionId + '（借款還款 #' + repaymentId + ' 產生）');
        }
        const afterData = { id: repaymentId, financing_id: parseInt(id, 10), payment_date, principal_paid: principal_paid || 0, interest_paid: interest_paid || 0, remarks: remarks || null };
        writeOperationLog(req, 'create', 'financing_repayment', repaymentId, null, afterData, '還款記錄 #' + repaymentId + '（' + (facilityName || '') + '）');

        // 以銀行顯示的還款後本金餘額校正（見上方說明）
        let calibration = null;
        let warning = null;
        const before = await new Promise((resolve, reject) => {
            db.get(`SELECT ${REMAINING_PRINCIPAL_SQL} AS remaining, f.manual_principal_balance, f.manual_balance_date FROM financing f WHERE f.id = ?`, [id],
                (err, row) => (err ? reject(err) : resolve(row)));
        });
        if (bankBalance !== null) {
            const systemBalance = parseFloat(before.remaining) || 0;
            await new Promise((resolve, reject) => {
                db.run('UPDATE financing SET manual_principal_balance = ?, manual_balance_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [bankBalance, payment_date, id], (err) => (err ? reject(err) : resolve()));
            });
            calibration = { system_balance: systemBalance, bank_balance: bankBalance, diff: bankBalance - systemBalance, base_date: payment_date };
            writeOperationLog(req, 'update', 'financing', id,
                { manual_principal_balance: before.manual_principal_balance, manual_balance_date: before.manual_balance_date },
                { manual_principal_balance: bankBalance, manual_balance_date: payment_date },
                `借款 #${id} 依銀行還款後本金餘額校正：系統推算 ${systemBalance}，銀行 ${bankBalance}`);
        } else if (before.manual_principal_balance != null && before.manual_balance_date && payment_date <= before.manual_balance_date
            && (parseFloat(principal_paid) || 0) > 0) {
            warning = `這筆還款日期（${payment_date}）不晚於手動輸入的本金餘額基準日（${before.manual_balance_date}），視為已包含在該餘額中，沒有再扣減；如要以這筆為準，請填「銀行顯示的還款後本金餘額」`;
        }

        let message = '還款記錄已新增' + (transactionId ? '，已同步建立收支記錄並更新帳戶餘額' : '（此借款未設定還款帳戶，未建立對應收支記錄）');
        if (calibration) {
            const f = (n) => Math.round(n).toLocaleString('en-US');
            message += Math.abs(calibration.diff) < 0.5
                ? `；已用銀行餘額 ${f(calibration.bank_balance)} 校正（與系統推算一致）`
                : `；已用銀行餘額 ${f(calibration.bank_balance)} 校正，系統原本推算 ${f(calibration.system_balance)}，差 ${calibration.diff > 0 ? '+' : ''}${f(calibration.diff)}（前面某期的本金／利息可能填錯，可在還款記錄逐期核對）`;
        }
        templateSync.advanced.forEach((a) => {
            message += a.deactivated ? `；連結範本「${a.name}」已到期並停用` : `；連結範本「${a.name}」的下次產生日已順延到 ${a.to}`;
        });
        if (templateSync.skippedMultiple) message += '；這筆借款連結了多個週期範本，無法判斷要順延哪一個，請到週期範本確認各自的下次產生日';
        res.json({ success: true, id: repaymentId, transactionId, message, calibration, warning, template_sync: templateSync.advanced });
    } catch (error) {
        // 還款記錄沒寫成功，但交易已經建立的話要撤銷，避免留下一筆沒有對應還款記錄的交易
        if (transactionId) {
            db.run('DELETE FROM transactions WHERE id = ?', [transactionId], async (delErr) => {
                if (delErr) {
                    logger.error('回滾交易記錄失敗，交易 #' + transactionId + ' 可能殘留，請手動檢查:', delErr);
                    return;
                }
                if (financingAccount && financingAccount.account_name) {
                    try {
                        await updateBankAccountBalance(financingAccount.account_name, financingAccount.account_number, financingAccount.company_name || null);
                    } catch (balanceErr) {
                        logger.error('回滾後更新帳戶餘額失敗:', balanceErr);
                    }
                }
            });
        }
        if (error.message === '找不到借款記錄') {
            return res.status(404).json({ error: error.message });
        }
        logger.error('新增還款記錄錯誤:', error);
        res.status(500).json({ error: '新增失敗', details: error.message });
    }
});

// 刪除一筆還款記錄
router.delete('/:id/repayments/:repaymentId', requireEditor, (req, res) => {
    const { id, repaymentId } = req.params;
    db.get('SELECT * FROM financing_repayments WHERE id = ? AND financing_id = ?', [repaymentId, id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到還款記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM financing_repayments WHERE id = ?', [repaymentId], function (delErr) {
            if (delErr) {
                logger.error('刪除還款記錄錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到還款記錄' });
            writeOperationLog(req, 'delete', 'financing_repayment', repaymentId, row, null, '還款記錄 #' + repaymentId);
            res.json({ success: true, message: '還款記錄已刪除' });
        });
    });
});

module.exports = router;
