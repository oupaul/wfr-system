/**
 * ledger-tour.js — 資金流水帳的「4 步驟導覽」。
 * 第一次進資金預估週報時自動跑一次，框出重點並用一句話說明（看三個數字、帳戶欄、黃底檢查點、斜體預計）；
 * 之後可從右下角「？ 操作說明」裡的「🧭 開始導覽」重看。找不到的元素（例如沒有預計列）會自動略過。
 */
(function () {
    'use strict';
    const SEEN_KEY = 'ledgerTourSeen';

    const STEPS = [
        { sel: '.ledger-stats', title: '① 先看這三個數字', text: '「可用資金」是活存加定存；「目前貸款餘額」是借款還剩多少本金；右邊是兩者相減。藍底表示可用資金足夠還貸款，紅底表示不夠，並會寫短少多少。' },
        { sel: '.ledger-table thead th:nth-child(3)', fallback: '.ledger-table thead', title: '② 每一欄是一個銀行帳戶', text: '往下是日期，一列一天的收支。滑到下面時，帳戶名稱會固定在最上方，不用捲回來找；手機請左右滑動。' },
        { sel: '.ledger-row-balance', title: '③ 黃底列是「結餘檢查點」', text: '預設每月 15 號和 30 號，這一列顯示各帳戶「預計餘額」。餘額如果低於該帳戶的安全水位，就是資金缺口。檢查日各公司可在「公司管理」自訂。' },
        { sel: '.ledger-projected', title: '④ 斜體「（預計）」不是真實交易', text: '這是依借款還款、週期範本、定存到期推算的預估，不影響真實餘額。實際發生並登記後，這一列會被真實交易取代。' },
        { sel: '#accountFilterBtn', title: '⑤ 想只看某幾個帳戶？', text: '按「🏦 顯示帳戶」勾選要看的。以後想再看這個導覽，點右下角「？ 操作說明」→「🧭 開始導覽」。' }
    ];

    let idx = 0, steps = [], mask, box, card;

    function close(markSeen) {
        [mask, box, card].forEach((n) => n && n.remove());
        mask = box = card = null;
        window.removeEventListener('resize', place);
        if (markSeen) { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* 忽略 */ } }
    }

    function place() {
        if (!steps.length || !box) return;
        const s = steps[idx];
        const el = s.el;
        const r = el.getBoundingClientRect();
        const pad = 6;
        Object.assign(box.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' });
        const cw = Math.min(340, window.innerWidth - 24);
        card.style.width = cw + 'px';
        let left = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12));
        let top = r.bottom + 14;
        if (top + card.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - card.offsetHeight - 14);
        card.style.left = left + 'px';
        card.style.top = top + 'px';
    }

    function render() {
        const s = steps[idx];
        s.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        card.innerHTML = `<div style="font-size:12px;color:#94A3B8;margin-bottom:4px">${idx + 1} / ${steps.length}</div>`
            + `<div style="font-weight:bold;font-size:15px;margin-bottom:6px">${s.title}</div>`
            + `<div style="font-size:13.5px;line-height:1.7;color:#E2E8F0">${s.text}</div>`
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">'
            + '<button data-act="skip" style="background:none;border:0;color:#94A3B8;cursor:pointer;font-size:13px">略過導覽</button>'
            + '<span>' + (idx > 0 ? '<button data-act="prev" style="background:#334155;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;margin-right:6px">上一步</button>' : '')
            + `<button data-act="next" style="background:#F06000;color:#fff;border:0;border-radius:6px;padding:7px 14px;cursor:pointer;font-weight:bold">${idx === steps.length - 1 ? '完成' : '下一步'}</button></span></div>`;
        setTimeout(place, 250);
    }

    function start() {
        steps = STEPS.map((s) => ({ ...s, el: document.querySelector(s.sel) || (s.fallback && document.querySelector(s.fallback)) })).filter((s) => s.el);
        if (!steps.length) return;
        close(false);
        idx = 0;
        mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;z-index:9200;background:transparent';
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:9201;border:3px solid #F06000;border-radius:8px;box-shadow:0 0 0 9999px rgba(15,23,42,.55);pointer-events:none;transition:all .2s';
        card = document.createElement('div');
        card.style.cssText = 'position:fixed;z-index:9202;background:#1E293B;color:#fff;border-radius:10px;padding:14px 16px;box-shadow:0 6px 24px rgba(0,0,0,.35);font-family:inherit';
        card.addEventListener('click', (e) => {
            const act = e.target && e.target.getAttribute('data-act');
            if (!act) return;
            if (act === 'skip') return close(true);
            if (act === 'prev' && idx > 0) idx--;
            else if (act === 'next') { if (idx >= steps.length - 1) return close(true); idx++; }
            render();
        });
        mask.addEventListener('click', () => close(true));
        document.body.append(mask, box, card);
        window.addEventListener('resize', place);
        render();
    }
    window.startLedgerTour = start;

    // 第一次進來：等流水帳畫出來（找得到黃底列）再自動開始
    function autoStart() {
        let seen = false;
        try { seen = !!localStorage.getItem(SEEN_KEY); } catch (e) { seen = true; }
        if (seen) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (document.querySelector('.ledger-row-balance')) { clearInterval(timer); setTimeout(start, 600); }
            else if (tries > 40) clearInterval(timer);
        }, 500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart); else autoStart();
})();
