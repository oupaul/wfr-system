// 首頁「待辦事項」：財務人員／管理員一登入就看到現在該做什麼，每一項附一個按鈕直接跳到要操作的頁面。
// 只做查詢，不寫任何資料；項目依緊急程度排序（逾期 → 即將到期 → 提醒）。
const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { requireEditor } = require('../middleware/auth');
const { dbAll, loadActiveAccounts } = require('../utils/cashGapData');
const { getLatestSettlementsForAccounts } = require('../utils/settlementLookup');
const { REMAINING_PRINCIPAL_SQL } = require('../utils/financingProjection');
const { todayInTaipei, addDaysStr } = require('../utils/dateUtil');
const { daysBetween } = require('../utils/financingSchedule');
const { findDuplicateGroups } = require('../utils/accountIdentity');

const SOON_DAYS = 7;          // 幾天內到期算「即將到期」
const STALE_SETTLEMENT_DAYS = 35; // 超過幾天沒結算要提醒（月底對帳通常每月一次）
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

router.get('/', requireEditor, async (req, res) => {
    try {
        const today = todayInTaipei();
        const soonDate = addDaysStr(today, SOON_DAYS);
        const items = [];

        // 0. 帳戶身分重複（公司＋名稱＋帳號完全相同）：系統無法區分，餘額與可用資金會算錯，優先處理
        const dupGroups = await findDuplicateGroups(db);
        if (dupGroups.length) {
            items.push({
                kind: 'duplicate_account', level: 'overdue', title: `${dupGroups.length} 組銀行帳戶的公司、名稱、帳號完全相同`,
                detail: dupGroups.map((g) => `${g[0].account_name}（${g[0].account_number ? '帳號末四碼 ' + String(g[0].account_number).replace(/[^0-9A-Za-z]/g, '').slice(-4) : '無帳號'}）：${g.map((a) => `#${a.id} ${[a.bank_name, a.account_type].filter(Boolean).join('・')}`).join('、')}`).join('；')
                    + '。系統無法區分，餘額與可用資金會算錯；常見是同一個帳號底下的活存與定存，請把定存帳戶改名（例如加上「定存」）',
                href: '/bank-accounts.html', action: '前往銀行帳戶'
            });
        }

        // 1. 週期範本：已到期未確認／即將到期
        const templates = await dbAll(
            `SELECT rt.id, rt.type, rt.amount, rt.category, rt.description, rt.next_run_date, rt.financing_id, f.facility_name
             FROM recurring_transactions rt LEFT JOIN financing f ON f.id = rt.financing_id
             WHERE rt.is_active = 1 AND rt.next_run_date IS NOT NULL AND rt.next_run_date <= ?
             ORDER BY rt.next_run_date`, [soonDate]);
        templates.forEach((t) => {
            const overdue = t.next_run_date < today;
            const name = t.description || t.category || '週期範本';
            const days = daysBetween(t.next_run_date, today);
            items.push({
                kind: 'template', level: overdue ? 'overdue' : 'soon',
                title: `${name}${t.financing_id ? '（借款還款）' : ''}`,
                detail: overdue ? `已到期 ${days} 天（排定 ${t.next_run_date}），預估 ${fmt(t.amount)} 元`
                    : (t.next_run_date === today ? `今天到期，預估 ${fmt(t.amount)} 元` : `${t.next_run_date} 到期，預估 ${fmt(t.amount)} 元`),
                href: `/recurring-transactions.html?confirm=${t.id}`, action: '確認本期入帳'
            });
        });

        // 2. 定存：已到期還沒確認
        const deposits = await dbAll(
            `SELECT ba.id, ba.account_name, ba.deposit_maturity_date, ba.current_balance
             FROM bank_accounts ba
             WHERE ba.is_active = 1 AND ba.account_type = '定存' AND ba.deposit_maturity_date IS NOT NULL
               AND ba.deposit_maturity_date <= ? AND ba.current_balance > 0
             ORDER BY ba.deposit_maturity_date`, [today]);
        deposits.forEach((d) => {
            items.push({
                kind: 'deposit', level: 'overdue', title: `定存「${d.account_name}」已到期`,
                detail: `到期日 ${d.deposit_maturity_date}，餘額 ${fmt(d.current_balance)} 元；銀行入帳後請按「解約／到期」確認`,
                href: '/bank-accounts.html', action: '前往銀行帳戶'
            });
        });

        // 3. 借款：沒有連結範本、下次還款日已到或即將到
        const loans = await dbAll(
            `SELECT f.id, f.facility_name, f.next_payment_date, f.next_payment_amount, ${REMAINING_PRINCIPAL_SQL} AS remaining
             FROM financing f
             WHERE f.is_active = 1 AND f.next_payment_date IS NOT NULL AND f.next_payment_date <= ?
               AND NOT EXISTS (SELECT 1 FROM recurring_transactions rt WHERE rt.financing_id = f.id AND rt.is_active = 1 AND rt.next_run_date IS NOT NULL)
             ORDER BY f.next_payment_date`, [soonDate]);
        loans.filter((l) => (parseFloat(l.remaining) || 0) > 0).forEach((l) => {
            const overdue = l.next_payment_date < today;
            items.push({
                kind: 'loan', level: overdue ? 'overdue' : 'soon', title: `借款「${l.facility_name}」該還款了`,
                detail: `${overdue ? '已逾期（' : '下次還款日 '}${l.next_payment_date}${overdue ? '）' : ''}${l.next_payment_amount ? `，預計 ${fmt(l.next_payment_amount)} 元` : ''}`,
                href: `/financing.html?repay=${l.id}`, action: '登記還款'
            });
        });

        // 4. 帳戶太久沒結算
        const accounts = (await loadActiveAccounts()).filter((a) => a.account_type !== '授信');
        const latest = await getLatestSettlementsForAccounts(db, accounts);
        const stale = [];
        accounts.forEach((a) => {
            const s = latest.get(a.id);
            if (!s) stale.push({ a, days: null });
            else {
                const days = daysBetween(s.settlement_date, today);
                if (days > STALE_SETTLEMENT_DAYS) stale.push({ a, days, date: s.settlement_date });
            }
        });
        // 帳戶很多時一項一項列會淹沒其他待辦，所以合併成「沒有期初結算」與「太久沒結算」各一項；
        // 每個帳戶附上完整辨識資訊（公司・銀行・帳戶名稱（類型）・帳號末四碼），前端展開後逐一列出，
        // 各自一個按鈕帶到結算頁並預選那個帳戶
        const tail = (n) => (n ? `帳號末四碼 ${String(n).replace(/[^0-9A-Za-z]/g, '').slice(-4)}` : '無帳號');
        const label = (a) => `${a.company_name ? a.company_name + '・' : ''}${a.bank_name ? a.bank_name + '・' : ''}${a.account_name}（${a.account_type || '帳戶'}）・${tail(a.account_number)}`;
        const detailOf = (x) => (x.days === null ? '從未結算' : `上次結算 ${x.date}（${x.days} 天前）`);
        const toAccount = (x) => ({ id: x.a.id, label: label(x.a), detail: detailOf(x), href: `/settlement.html?account=${x.a.id}` });
        const never = stale.filter((x) => x.days === null);
        const old = stale.filter((x) => x.days !== null).sort((p, q) => q.days - p.days);
        if (never.length) {
            items.push({ kind: 'settlement', level: 'overdue', title: `${never.length} 個帳戶還沒有期初結算`,
                detail: '沒有結算系統就無法計算餘額，請先建立期初餘額。點開看是哪些帳戶',
                href: '/settlement.html', action: '前往餘額結算', accounts: never.map(toAccount) });
        }
        if (old.length) {
            items.push({ kind: 'settlement', level: 'info', title: `${old.length} 個帳戶超過 ${STALE_SETTLEMENT_DAYS} 天沒結算`,
                detail: `最久 ${old[0].days} 天。月底請輸入銀行實際餘額對帳。點開看是哪些帳戶`,
                href: '/settlement.html', action: '前往餘額結算', accounts: old.map(toAccount) });
        }

        const rank = { overdue: 0, soon: 1, info: 2 };
        items.sort((x, y) => rank[x.level] - rank[y.level]);
        res.json({
            today, count: items.length,
            counts: { overdue: items.filter((i) => i.level === 'overdue').length, soon: items.filter((i) => i.level === 'soon').length, info: items.filter((i) => i.level === 'info').length },
            items
        });
    } catch (err) {
        logger.error('查詢待辦事項錯誤:', err);
        res.status(500).json({ error: '查詢失敗', details: err.message });
    }
});

module.exports = router;
