/**
 * term-help.js — 名詞旁的「?」小提示。
 * 頁面上出現這些陌生名詞（表頭、欄位標籤、標題）時，自動在後面加一個「?」，點一下（或手機輕點）用一句白話解釋。
 * 只比對「整段文字就是這個名詞」的元素（th／label／h3／.term 等），不會動到說明文字內容。
 * 要新增名詞：在 TERMS 加一筆；要在特定位置強制加，給元素 data-term="名詞"。
 */
(function () {
    'use strict';

    const TERMS = {
        '結餘檢查點': '每月固定幾號（預設 15、30 號，各公司可自訂）系統幫你檢查各帳戶預計餘額的日子；黃底列就是檢查點。',
        '安全水位': '這個帳戶最低要保留的金額。預計餘額低於它，就會出現資金缺口。',
        '資金缺口': '安全水位 − 預計餘額。預計餘額沒有低於安全水位，缺口就是 0。',
        '預計餘額': '最近一次結算的餘額，加上到那天為止的收入、減去支出，並已算進借款預計還款與週期範本。',
        '可用資金': '活存加定存的合計（依你目前勾選的帳戶）。',
        '目前貸款餘額': '借款管理裡所有啟用中借款的「目前本金餘額」加總。數字不對請到借款管理修正那一筆借款。',
        '目前本金餘額': '原始本金減掉已還的「本金」（只算還款日不晚於今天的）。利息不會讓本金變少。',
        '即時餘額': '最近一次結算的餘額，加上結算之後的收入、減去支出。',
        '期初餘額': '第一次使用前，到「餘額結算」輸入的銀行實際餘額，系統就從這裡開始往後算。',
        '差異': '銀行實際餘額減系統計算餘額。不是 0 代表可能漏登、重複登或帳戶選錯，請回收支記錄檢查。',
        '實際餘額': '你從銀行對帳單看到的餘額。',
        '計算餘額': '系統依期初餘額、期間收入與支出算出來的餘額。',
        '資金預測': '這筆借款有沒有被帶進資金預估週報的預測、金額從哪裡來；沒有預測會寫原因。',
        '下次產生日': '預測用這個日期往後排，也是這一期該入帳的日期；按「確認本期入帳」後會自動往後推一期。',
        '下次還款': '下一次該還款的日期與金額；登記還款涵蓋這個日期後，會自動往後推一期。',
        '下次還款日': '預測用這個日期往後排；登記還款涵蓋這個日期後，會自動往後推一期。',
        '還款後本金餘額': '登記這次還款之後，系統算出的剩餘本金；可以拿銀行對帳單逐期對照。',
        '安全水位合計': '各帳戶安全水位加總。'
    };

    // 供 scripts/build-quick-guide.js 產生「名詞對照」（Node 環境沒有 document，不啟動提示）
    if (typeof module !== 'undefined' && module.exports) { module.exports = { TERMS }; return; }

    const SELECTOR = 'th, label, h3, h4, .term, .stat-label, .card-label, .summary-label, .ledger-stat-label';

    function normalize(text) {
        return String(text || '')
            .replace(/[（(][^）)]*[）)]/g, '')              // 去掉括號補充，例如「可用資金（活存＋定存）」
            .replace(/[\s\u00a0*＊:：▾▸↑↓⇅]/g, '')         // 空白、必填星號、排序箭頭
            .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, ''); // emoji
    }

    let bubble = null;
    function hide() { if (bubble) { bubble.remove(); bubble = null; } }
    function show(target, term) {
        hide();
        bubble = document.createElement('div');
        bubble.setAttribute('role', 'tooltip');
        bubble.style.cssText = 'position:absolute;z-index:9100;max-width:260px;background:#1E293B;color:#fff;padding:9px 12px;border-radius:6px;font-size:13px;line-height:1.6;font-weight:normal;box-shadow:0 2px 10px rgba(0,0,0,.25);text-align:left;white-space:normal';
        bubble.innerHTML = '<b style="color:#FDBA74">' + term.replace(/</g, '&lt;') + '</b><br>' + TERMS[term].replace(/</g, '&lt;');
        document.body.appendChild(bubble);
        const r = target.getBoundingClientRect();
        const w = bubble.offsetWidth;
        const left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - w - 8));
        bubble.style.left = left + 'px';
        bubble.style.top = (window.scrollY + r.bottom + 6) + 'px';
    }

    function makeIcon(term) {
        const i = document.createElement('span');
        i.className = 'term-q';
        i.tabIndex = 0;
        i.setAttribute('role', 'button');
        i.setAttribute('aria-label', '什麼是' + term);
        i.textContent = '?';
        i.style.cssText = 'display:inline-block;margin-left:4px;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;background:#E2E8F0;color:#475569;font-size:11px;font-weight:bold;cursor:help;vertical-align:middle;user-select:none';
        const toggle = (e) => { e.stopPropagation(); e.preventDefault(); bubble && bubble._for === i ? hide() : (show(i, term), bubble._for = i); };
        i.addEventListener('click', toggle);
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); });
        return i;
    }

    function annotate(root) {
        (root || document).querySelectorAll(SELECTOR + ', [data-term]').forEach((el) => {
            if (el.dataset.termDone) return;
            if (el.closest('#pgHelpPanel')) return;
            const forced = el.getAttribute('data-term');
            const key = forced || normalize(el.textContent);
            if (!TERMS[key]) return;
            // 只處理純文字的元素，避免動到含輸入框等複雜內容的 label
            if (!forced && el.querySelector('input, select, textarea, button, table')) return;
            el.dataset.termDone = '1';
            el.appendChild(makeIcon(key));
        });
    }

    let timer = null;
    function schedule() { clearTimeout(timer); timer = setTimeout(() => annotate(document), 250); }

    function start() {
        annotate(document);
        new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
        document.addEventListener('click', hide);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
        window.addEventListener('scroll', hide, { passive: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
