/**
 * page-help.js — 每個頁面右下角的「？操作說明」。
 * 點開後從右側滑出「這一頁怎麼用」：先講這頁在看什麼，再用「我想要… → 3～5 個步驟」的任務卡說明常見操作。
 * 內容寫在下面的 PAGES；editor: true 的任務只有財務人員／管理員看得到（一般人員看不到對應按鈕）。
 * 文字請用畫面上的按鈕原文，改畫面時記得同步改這裡與 docs/操作手冊素材.md。
 */
(function () {
    'use strict';

    // steps：依序的操作；note：一句提醒（橘色左線）
    const PAGES = {
        '/cash-gap-dashboard.html': {
            title: '資金預估週報',
            tour: true,
            intro: '這一頁回答一個問題：「各銀行帳戶接下來的餘額夠不夠？」系統從最近一次結算的餘額往後推，加上已登記與預計的收支，在每個「檢查日」算出預計餘額，低於安全水位就標示資金缺口。',
            legend: [
                ['帳戶為欄、日期為列', '每一欄是一個銀行帳戶，每一列是一天的收支。'],
                ['黃底列（結餘檢查點）', '預設每月 15 號與 30 號，看這天各帳戶的預計餘額。'],
                ['斜體「（預計）」列', '依借款還款、週期範本、定存到期「推算」的預估，不是真實交易，不影響真實餘額；實際登記後會被真實交易取代。'],
                ['上方三個數字', '可用資金（活存＋定存）、目前貸款餘額、兩者相減；藍底＝可用資金夠還貸款，紅底＝不夠並標示短少多少。'],
                ['資金缺口', '安全水位 − 預計餘額。預計餘額沒低於安全水位，缺口就是 0。']
            ],
            tasks: [
                { q: '我只想看某幾個帳戶', steps: ['按工具列的「🏦 顯示帳戶」。', '勾選要看的帳戶（可「全選」「取消全選」）。'] },
                { q: '我想確認某一段時間的收支有沒有對', steps: ['勾選工具列的「顯示區間驗算」。', '每個黃底檢查點下方會多一列：上期餘額 ＋ 收入 − 支出 ＝ 本期餘額。', '顯示 ✓ 代表對得上；橘色 ⚠ 會顯示差額。', '點營業收支的金額，可直接開啟該區間、該帳戶的收支記錄。'] },
                { q: '我想知道「目前貸款餘額」包含哪些借款', steps: ['點該數字旁邊的「明細」。', '要修正數字，請到「💳 借款管理」改那一筆借款。'] },
                { q: '我想用手機看', steps: ['流水帳是寬表格，請左右滑動。', '也可以切到「📇 帳戶卡片」，一個帳戶一張卡片，比較好讀。'] },
                { q: '我想知道某個月的收支', steps: ['點月份標題展開或收合；預設只展開當月起的六個月。', '也可以按「全部展開」「全部收合」。'] }
            ],
            faq: [
                ['為什麼餘額跟銀行不一樣？', '餘額是從最近一次「結算」往後算的。請財務人員到「✅ 餘額結算」輸入銀行實際餘額，系統會顯示差異，再檢查是否漏登或重複。'],
                ['為什麼某筆預計沒出現？', '預計只顯示往後一年；若是借款，到「💳 借款管理」看該筆的「資金預測」欄，會寫明原因。']
            ]
        },

        '/transactions.html': {
            title: '收支記錄',
            intro: '所有真實的收入與支出都記在這裡，餘額就是由這些記錄加上最近一次結算算出來的。上方三個數字是目前篩選結果的總收入、總支出、淨收支（帳戶間轉帳不計入）。',
            legend: [
                ['公司 → 帳戶 要用下拉選單選', '系統用「公司＋帳戶名稱＋帳號」對應銀行帳戶，手打錯一個字，這筆就不會算進任何帳戶。'],
                ['轉帳徽章', '帳戶間轉帳會標示徽章，不計入收入／支出，只能整組刪除。']
            ],
            tasks: [
                { q: '我想查某個帳戶或某段期間的收支', steps: ['在篩選區選開始／結束日期、公司、帳戶，或輸入關鍵字。', '按「🔍 查詢」；要還原按「清除篩選」。', '點欄位標題可排序。'] },
                { q: '新增一筆收入或支出', editor: true, steps: ['按「➕ 新增收支記錄」。', '填交易日期、類型（收入／支出）、金額（有 * 的必填）。', '選公司，再選帳戶（帳號會自動帶入）。', '按「儲存」。'], note: '日期若早於該帳戶最近結算日，會出現橘字提醒：這筆會留在記錄裡，但不會算進目前餘額。' },
                { q: '一次匯入很多筆（從 Excel 複製貼上）', editor: true, steps: ['按「📋 貼上匯入」。', '在 Excel 選取要匯入的儲存格（可含表頭），Ctrl+C。', '點視窗的輸入框，Ctrl+V，下方立刻出現預覽。', '看「檢查結果」欄：✓ 可匯入、✗ 有錯誤、⚠ 要留意；每一格都能直接修改。', '全部沒有錯誤後按「確認匯入」。'], note: '疑似重複的列預設不勾選；單次最多 1000 筆，整批全有或全無。' },
                { q: '在兩個帳戶之間轉錢', editor: true, steps: ['按「🔁 轉帳」。', '填轉帳日期、金額、轉出帳戶、轉入帳戶。', '按「確認轉帳」。'], note: '轉到定存請改用「🏦 銀行帳戶」的「轉定存」，才會記錄利率與到期日。轉帳日期早於某個帳戶最近一次結算時，那一腿不會影響該帳戶的目前餘額（視窗會用橘字提醒）。轉帳不能編輯，做錯請刪除後重建。' },
                { q: '刪除記錄', editor: true, steps: ['單筆：按該列的「刪除」。', '多筆：勾選多列，按「🗑️ 批次刪除」。', '刪除後相關帳戶餘額會自動重算。'] }
            ],
            faq: [
                ['轉帳後轉出的帳戶沒減少、轉入的卻增加？', '轉帳日期早於轉出帳戶最近一次結算時，那一腿不會影響它的目前餘額（結算金額已視為包含）。請確認該帳戶的結算是否已包含這筆。', true],
                ['登記了但餘額沒變？', '先看日期是否早於該帳戶最近結算日，或公司／帳戶／帳號沒有選到正確的銀行帳戶。'],
                ['匯入時顯示「找不到帳戶」？', '貼上匯入的帳戶要和銀行帳戶管理裡的名稱一致；同名帳戶請在預覽表的下拉選單指定。', true]
            ]
        },

        '/settlement.html': {
            title: '餘額結算',
            intro: '「結算」是把銀行實際餘額登錄進系統，當作之後計算餘額的起點，同時比對系統算的和銀行實際差多少。每個帳戶第一次使用前，一定要先做一筆期初結算。',
            legend: [
                ['差異', '實際餘額 − 計算餘額，儲存後在「結算歷史記錄」查看。差異不是 0，代表漏登、重複登，或帳戶選錯。'],
                ['結算日當天的收支', '實際餘額請填「結算日當天開始前」的銀行餘額（前一天收盤餘額），當天的收支算在結算之後。']
            ],
            tasks: [
                { q: '第一次使用：建立期初餘額', editor: true, steps: ['選結算日期、公司、帳戶，按「📊 計算結算」。', '在下方勾選「我要輸入銀行實際餘額」。', '輸入銀行對帳單上的實際餘額（結算日當天開始前的餘額）。', '按「💾 儲存結算記錄」。'], note: '找不到帳戶時，按「➕ 快速新增帳戶」，填名稱、帳號、銀行、類型，按「儲存並選用」。' },
                { q: '月底用銀行餘額對帳', editor: true, steps: ['選結算日期、公司、帳戶，按「📊 計算結算」，看系統算出的計算餘額。', '勾選「我要輸入銀行實際餘額」，輸入銀行對帳單的餘額。', '按「💾 儲存結算記錄」。', '到下方「結算歷史記錄」看「差異」（實際餘額 − 計算餘額）；差異是 0 就對上了。'], note: '差異不是 0 時，回「收支記錄」檢查該期間有沒有漏登、重複或帳戶選錯。沒有勾選「我要輸入銀行實際餘額」就儲存，只會把系統算出的餘額存成結算，不會和銀行比對。' },
                { q: '查看歷史結算', steps: ['下方「結算歷史記錄」列出每次結算的期初、收入、支出、計算餘額、實際餘額與差異。'] }
            ],
            faq: [
                ['可以不結算嗎？', '沒有結算，系統就沒有起點，無法計算餘額。至少要有一筆期初結算。']
            ]
        },

        '/financing.html': {
            title: '借款管理',
            intro: '記錄每一筆借款或融資額度、目前還剩多少本金、下一次要還多少。設好之後，未來還款會自動出現在資金預估週報的「（預計）」列。',
            legend: [
                ['目前本金餘額', '原始本金 − 已還的「本金」。只計算還款日 ≤ 今天的記錄，未來日期的還款不會讓今天的餘額變少；利息不會減少本金。'],
                ['資金預測 欄', '告訴你這筆借款有沒有進入資金預估週報、金額怎麼來（依還款計畫表、範本固定金額或借款排程），沒預測會寫原因。']
            ],
            tasks: [
                { q: '我想看某筆借款還剩多少、下次什麼時候還', steps: ['在列表找到那筆借款，看「目前本金餘額」與「下次還款」。', '要看每次還款的明細，按該列的「還款記錄」，表格會列出每次的本金、利息與還款後本金餘額。'] },
                { q: '新增一筆借款', editor: true, steps: ['按「➕ 新增借款/額度」。', '填借款名稱、類型、原始本金、公司，並選「撥款/還款帳戶」。', '要讓未來還款出現在預測：填還款頻率、下次還款日、下次還款金額。', '按「儲存」。'], note: '如果有建連結的週期範本，預測以範本為準，借款自己的下次還款日／金額就不再用於預測。' },
                { q: '登記一次還款', editor: true, steps: ['按該筆借款的「還款記錄」。', '按「新增還款」，填還款日期、本金、利息。', '本金和利息要照銀行通知單分開填，利息不會減少本金餘額。', '儲存後，帳戶餘額與收支記錄會同步更新，借款的下次還款日（與連結範本的下次產生日）自動往後推一期。'], note: '有週期範本的借款，建議每期直接在「週期範本」按「確認本期入帳」，兩邊結果相同。銀行對帳單有「還款後貸款餘額」時，可填進「銀行還款後本金餘額」，系統會以銀行數字為準並告訴你差多少。' },
                { q: '匯入銀行或租賃公司給的還款計畫表', editor: true, steps: ['按「還款記錄」，切到「還款計畫表」分頁。', '展開「匯入／更新還款計畫表」。', '從 Excel 複製含表頭的表格（期數、日期、租金、利息、本金攤還、本金餘額）貼上。', '有每期加收營業稅（例如租金的 5%）時，「每期另加費用」選「租金的 %」填 5。', '看預覽的期數與合計無誤，按「確認匯入」，再按「以計畫表餘額校正」。'], note: '系統開始記帳之前已還的期數不要匯入：把期數 0 的本金餘額改成開始記帳當時的餘額，只留之後的期數。' },
                { q: '目前本金餘額跟銀行對不上', editor: true, steps: ['開「還款記錄」，看每一列的「還款後本金餘額」，和銀行對帳單逐期對照。', '從哪一期開始對不上，就是那一期（或前一期）的本金／利息填錯。', '修正後或直接按「以計畫表餘額校正」。'], note: '常見原因：把整筆扣款都填成本金、利息沒分開填、有一筆日期在未來。' }
            ],
            faq: [
                ['資金預測欄寫「未預測」？', '照欄位上的原因處理，常見：沒設還款帳戶、沒填下次還款金額、下次還款日設在很遠的未來。', true],
                ['計畫表可能需要更新？', '代表最近實際還款與計畫表不同（銀行可能調了利率），向銀行拿新試算表重新匯入即可。', true]
            ]
        },

        '/recurring-transactions.html': {
            title: '週期範本',
            intro: '房租、保費、薪資、借款還款這類固定重複的收支，建成範本。範本不會自動入帳，每期要人工按「確認本期入帳」確認實際金額，系統才會寫入收支記錄。',
            legend: [
                ['下次產生日', '預測用這個日期往後排；按「確認本期入帳」後會自動往後推一期。'],
                ['已到期', '下次產生日已過但還沒按「確認本期入帳」；預測會把它算在今天。'],
                ['連結借款', '連結後，確認本期入帳會同時記收支與借款還款，並自動推進借款的下次還款日。']
            ],
            tasks: [
                { q: '新增一個固定收支範本', steps: ['按「➕ 新增範本」。', '選類型、頻率（每月／每季／每年）、金額（視為預估值）。', '選公司與帳戶、填下次產生日。', '按「儲存」。'] },
                { q: '每期固定要做：確認本期入帳', steps: ['在該範本列按「確認本期入帳」。', '把「實際入帳日期」「實際金額」改成真實的。', '連結借款時，本金與利息會依還款計畫表自動帶入，可再調整。', '按「確認入帳」。'], note: '預設勾選「同時把範本預估金額更新為這次的實際金額」，下次預測會用新金額。' },
                { q: '建立借款還款範本', steps: ['先到「借款管理」建好借款，並（有的話）匯入還款計畫表。', '新增範本時，「連結借款」選那筆借款，填本金與利息、下次產生日。', '一筆借款只建一個範本，預測才會依計畫表每期金額自動變動。'], note: '下次產生日要對得上借款的還款日，才找得到計畫表的那一期（相差 20 天內）。' }
            ],
            faq: [
                ['範本的帳戶出現橘色警示？', '代表範本記的帳戶對不上任何啟用中的銀行帳戶，預測與餘額都不會計入。按編輯，重新選公司與帳戶即可。']
            ]
        },

        '/bank-accounts.html': {
            title: '銀行帳戶管理',
            intro: '每家公司的銀行帳戶都在這裡維護。「安全水位」是該帳戶最低要保留的金額，預計餘額低於它就會出現資金缺口。活存可以轉定存，定存到期或解約再轉回活存。',
            legend: [
                ['即時餘額', '最近一次結算 ＋ 之後的收支。'],
                ['安全水位', '這個帳戶最低保留金額，資金缺口依它計算。']
            ],
            tasks: [
                { q: '新增銀行帳戶', editor: true, steps: ['按「➕ 新增帳戶」，選所屬公司。', '填帳戶名稱、帳號、銀行、帳戶類型（活存／定存…）、安全水位。', '按「儲存」，再到「餘額結算」建立期初餘額。'] },
                { q: '活存轉定存', editor: true, steps: ['在活存帳戶那一列按「轉定存」。', '填存入日期、金額、年利率、到期日。', '選一個餘額為 0 的定存帳戶，或新增一個。', '按「確認轉定存」。'], note: '一個定存帳戶一次只放一筆；要存第二筆請新增另一個定存帳戶。到期日前，預測會自動帶入到期回到活存。' },
                { q: '定存到期或解約', editor: true, steps: ['等銀行把本金和利息入帳後再操作。', '在定存帳戶那一列按「解約／到期」。', '日期填實際入帳日，利息改成銀行實際入帳的金額。', '按「確認解約／到期」。'], note: '系統不會自動入帳，已到期未確認的定存會標示「已到期」。提前解約可以只轉回一部分本金。' },
                { q: '查某個帳戶的明細', steps: ['按該帳戶的「交易明細」，會跳到收支記錄並自動套用該帳戶的篩選。'] }
            ],
            faq: [
                ['銀行定存自動續存怎麼記？', '先按「解約／到期」把本金轉回活存，再用「轉定存」存入新的一筆，利率與到期日填新的。', true]
            ]
        }
    };

    // 供 scripts/build-quick-guide.js 讀同一份內容產生「快速操作指南」（Node 環境沒有 document，不啟動說明按鈕）
    if (typeof module !== 'undefined' && module.exports) { module.exports = { PAGES }; return; }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function css() {
        const style = document.createElement('style');
        style.textContent = `
        #pgHelpBtn{position:fixed;right:16px;bottom:16px;z-index:9000;background:#1E293B;color:#fff;border:0;border-radius:24px;padding:11px 18px;font-size:15px;font-weight:bold;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);font-family:inherit}
        #pgHelpBtn:hover{background:#334155}
        #pgHelpTip{position:fixed;right:16px;bottom:66px;z-index:9000;background:#fff;color:#1E293B;border:1px solid #CBD5E1;border-left:4px solid #F06000;border-radius:6px;padding:8px 12px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.15);max-width:220px}
        #pgHelpMask{position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:9001;display:none}
        #pgHelpPanel{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:100%;background:#fff;z-index:9002;box-shadow:-4px 0 18px rgba(0,0,0,.2);transform:translateX(100%);transition:transform .2s;display:flex;flex-direction:column;font-family:inherit;color:#1E293B}
        #pgHelpPanel.open{transform:none}
        #pgHelpPanel header{background:#1E293B;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}
        #pgHelpPanel header h2{margin:0;font-size:17px}
        #pgHelpClose{background:none;border:0;color:#fff;font-size:24px;cursor:pointer;line-height:1}
        #pgHelpBody{overflow-y:auto;padding:16px;font-size:14px;line-height:1.7}
        #pgHelpBody h3{font-size:15px;margin:18px 0 8px;color:#1E293B}
        #pgHelpBody .intro{background:#F8FAFC;border-left:4px solid #1E293B;padding:10px 12px;border-radius:4px;margin:0 0 4px}
        #pgHelpBody dl{margin:0}
        #pgHelpBody dt{font-weight:bold;margin-top:8px}
        #pgHelpBody dd{margin:0;color:#475569}
        #pgHelpBody details{border:1px solid #E2E8F0;border-radius:6px;margin:8px 0;background:#fff}
        #pgHelpBody summary{cursor:pointer;padding:10px 12px;font-weight:bold;list-style:none}
        #pgHelpBody summary::-webkit-details-marker{display:none}
        #pgHelpBody summary::before{content:'▸ ';color:#F06000}
        #pgHelpBody details[open] summary::before{content:'▾ '}
        #pgHelpBody details[open] summary{border-bottom:1px solid #E2E8F0}
        #pgHelpBody ol{margin:10px 12px 10px 0;padding-left:34px}
        #pgHelpBody li{margin:6px 0}
        #pgHelpBody .note{margin:0 12px 12px;padding:8px 10px;border-left:4px solid #F06000;background:#FFF7ED;color:#7C2D12;font-size:13px;border-radius:4px}
        #pgHelpBody .viewonly{color:#64748B;font-size:12px;margin:6px 0 0}
        #pgHelpBody .foot{margin-top:18px;font-size:12px;color:#64748B}
        @media print{#pgHelpBtn,#pgHelpTip,#pgHelpMask,#pgHelpPanel{display:none!important}}
        `;
        document.head.appendChild(style);
    }

    function build(page, isEditor) {
        const tasks = page.tasks.filter((t) => isEditor || !t.editor);
        const hidden = page.tasks.length - tasks.length;
        let html = `<p class="intro">${esc(page.intro)}</p>`;
        if (page.tour) html += '<button type="button" id="pgHelpTour" style="margin:10px 0 0;background:#F06000;color:#fff;border:0;border-radius:6px;padding:9px 14px;font-weight:bold;cursor:pointer;font-family:inherit">🧭 開始 5 步驟導覽（框出重點給你看）</button>';
        if (page.legend && page.legend.length) {
            html += '<h3>看懂畫面</h3><dl>' + page.legend.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + '</dl>';
        }
        if (tasks.length) html += '<h3>我想要…（點開看步驟）</h3>';
        html += tasks.map((t, i) => `<details${i === 0 ? ' open' : ''}><summary>${esc(t.q)}</summary><ol>${t.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}</details>`).join('');
        if (hidden) html += '<p class="viewonly">新增、修改、匯入等操作需要「財務人員」權限，你的帳號只能查詢；有需要請洽管理員。</p>';
        const faq = (page.faq || []).filter((f) => isEditor || !f[2]);
        if (faq.length) {
            html += '<h3>常見疑問</h3>' + faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><div style="padding:10px 12px;color:#475569">${esc(a)}</div></details>`).join('');
        }
        html += '<p class="foot">完整說明請見「系統操作手冊」，或洽管理員。</p>';
        return html;
    }

    function init(isEditor) {
        const page = PAGES[window.location.pathname];
        if (!page) return;
        css();

        const btn = document.createElement('button');
        btn.id = 'pgHelpBtn';
        btn.type = 'button';
        btn.setAttribute('aria-label', '開啟這一頁的操作說明');
        btn.textContent = '？ 操作說明';
        const mask = document.createElement('div');
        mask.id = 'pgHelpMask';
        const panel = document.createElement('aside');
        panel.id = 'pgHelpPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', page.title + ' 操作說明');
        panel.innerHTML = `<header><h2>${esc(page.title)}：怎麼用</h2><button id="pgHelpClose" type="button" aria-label="關閉">×</button></header><div id="pgHelpBody">${build(page, isEditor)}</div>`;
        document.body.appendChild(btn);
        document.body.appendChild(mask);
        document.body.appendChild(panel);

        const open = () => { mask.style.display = 'block'; panel.classList.add('open'); const tip = document.getElementById('pgHelpTip'); if (tip) tip.remove(); try { localStorage.setItem('pgHelpSeen:' + window.location.pathname, '1'); } catch (e) { /* 無法儲存就算了 */ } };
        const close = () => { mask.style.display = 'none'; panel.classList.remove('open'); };
        btn.addEventListener('click', open);
        mask.addEventListener('click', close);
        panel.querySelector('#pgHelpClose').addEventListener('click', close);
        const tourBtn = panel.querySelector('#pgHelpTour');
        if (tourBtn) tourBtn.addEventListener('click', () => { close(); if (window.startLedgerTour) window.startLedgerTour(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

        // 第一次進這個頁面時提示一次
        let seen = false;
        try { seen = !!localStorage.getItem('pgHelpSeen:' + window.location.pathname); } catch (e) { seen = true; }
        if (!seen && !page.tour) {
            const tip = document.createElement('div');
            tip.id = 'pgHelpTip';
            tip.textContent = '不知道怎麼操作？點這裡看這一頁的說明';
            document.body.appendChild(tip);
            setTimeout(() => { const t = document.getElementById('pgHelpTip'); if (t) t.remove(); }, 8000);
        }
    }

    function start() {
        fetch('/api/auth/check', { credentials: 'include', cache: 'no-store' })
            .then((r) => r.json())
            .then((res) => {
                if (!res || !res.authenticated) return;
                init(res.user && (res.user.role === 'admin' || res.user.role === 'finance'));
            })
            .catch(() => { /* 取不到登入資訊就不顯示說明按鈕 */ });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
