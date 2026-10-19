// 產生兩本「快速操作指南」（可直接列印成 PDF）：
//   docs/快速操作指南-一般同仁.html   只查詢的同仁：怎麼看資金流水帳、怎麼查收支、名詞對照
//   docs/快速操作指南-財務人員.html   日常登記：待辦、確認本期入帳、還款、轉定存、結算…
// 內容與系統各頁面右下角的「？操作說明」、名詞的「?」提示是同一份（public/js/page-help.js 的 PAGES、
// public/js/term-help.js 的 TERMS），改一處兩邊同步：
//   node scripts/build-quick-guide.js              產生不含截圖的版本（可放心 commit）
//   node scripts/build-quick-guide.js --with-images  把 docs/images/ 的標註截圖內嵌進去（截圖來自測試資料庫，
//                                                    確認沒有敏感資料再決定要不要 commit）
const fs = require('fs');
const path = require('path');
const { PAGES } = require('../public/js/page-help.js');
const { TERMS } = require('../public/js/term-help.js');

const WITH_IMAGES = process.argv.includes('--with-images');
const DOCS = path.join(__dirname, '..', 'docs');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAV = {
    '/cash-gap-dashboard.html': '⚠️ 資金預估週報', '/transactions.html': '💰 收支記錄', '/settlement.html': '✅ 餘額結算',
    '/financing.html': '💳 借款管理', '/recurring-transactions.html': '🔁 週期範本', '/bank-accounts.html': '🏦 銀行帳戶'
};

// 標註截圖（橘色框與編號）；沒有加 --with-images 時只顯示圖說文字
const IMAGES = {
    '/cash-gap-dashboard.html': [{ f: 'ledger.jpg', cap: '① 三個數字　② 每一欄是一個銀行帳戶　③ 黃底列＝結餘檢查點　④ 斜體「（預計）」＝推算的預估' }],
    '/transactions.html': [{ f: 'transactions.jpg', cap: '① 新增單筆　② 貼上匯入（從 Excel 複製貼上）　③ 帳戶間轉帳' }],
    '/recurring-transactions.html': [
        { f: 'recurring.jpg', cap: '① 每期到期時按「確認本期入帳」' },
        { f: 'recurring-confirm.jpg', cap: '① 改成實際入帳日期　② 連結借款時本金／利息可調整　③ 按「確認入帳」' }],
    '/settlement.html': [
        { f: 'settlement-form.jpg', cap: '① 結算日期　② 公司　③ 帳戶（選填）　④ 按「📊 計算結算」，下方會出現系統算出的計算餘額' },
        { f: 'settlement-actual.jpg', cap: '① 勾選「我要輸入銀行實際餘額」　② 輸入銀行對帳單的餘額（結算日當天開始前）　③ 按「💾 儲存結算記錄」；儲存後到結算歷史看「差異」' }],
    '/financing.html': [{ f: 'financing-repay.jpg', cap: '① 有連結週期範本的借款，會提示到範本確認本期入帳　② 在這裡新增還款也可以　③ 有計畫表時可切到「還款計畫表」' }],
    '/bank-accounts.html': [{ f: 'deposit.jpg', cap: '① 活存帳戶按「轉定存」　② 定存帳戶到期或解約按「解約／到期」' }]
};
const HOME_IMAGE = { f: 'home-todo.jpg', cap: '① 每一項是一件該處理的事　② 按右邊的按鈕直接跳到要操作的頁面' };

function imageHtml(img) {
    if (!img) return '';
    const file = path.join(DOCS, 'images', img.f);
    let tag = '';
    if (WITH_IMAGES && fs.existsSync(file)) {
        tag = `<img src="data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}" alt="${esc(img.cap)}">`;
    }
    return `<figure>${tag}<figcaption>${esc(img.cap)}</figcaption></figure>`;
}

const css = `
  :root { --ink:#1E293B; --muted:#475569; --line:#E2E8F0; --accent:#F06000; --bg:#F8FAFC; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif; color:var(--ink); background:#fff; line-height:1.75; font-size:15px; }
  main { max-width:860px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:28px; margin:8px 0 4px; } .sub { color:var(--muted); margin:0 0 20px; }
  h2 { font-size:21px; margin:0 0 10px; border-bottom:3px solid var(--ink); padding-bottom:6px; }
  h3 { font-size:16px; margin:16px 0 6px; } h4 { font-size:15px; margin:0 0 6px; }
  .card, .page { margin:0 0 28px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:18px; } @media (max-width:640px){ .two { grid-template-columns:1fr; } }
  .box { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:4px 16px 8px; }
  ol { margin:6px 0; padding-left:24px; } li { margin:4px 0; }
  .warn, .note { border-left:4px solid var(--accent); background:#FFF7ED; color:#7C2D12; padding:8px 12px; border-radius:4px; font-size:14px; margin:8px 0; }
  .intro { background:var(--bg); border-left:4px solid var(--ink); padding:10px 14px; border-radius:4px; }
  dl { margin:0; } dt { font-weight:bold; margin-top:8px; } dd { margin:0; color:var(--muted); }
  .task { border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin:10px 0; break-inside:avoid; }
  .badge { font-size:12px; font-weight:normal; background:var(--ink); color:#fff; border-radius:10px; padding:1px 8px; margin-left:8px; }
  figure { margin:12px 0; } figure img { width:100%; border:1px solid var(--line); border-radius:6px; } figcaption { font-size:13px; color:var(--muted); margin-top:4px; }
  table { border-collapse:collapse; width:100%; font-size:14px; } th, td { border:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:top; } th { background:var(--bg); }
  @media print { .page { break-before:page; } body { font-size:13px; } main { padding:0; } }
`;

const doc = (title, sub, body) => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${css}</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">${esc(sub)}</p>
${body}
</main></body></html>`;

const termsTable = (names) => `
<section class="card"><h2>名詞對照（看不懂的字在這裡）</h2>
<table><tr><th>名詞</th><th>白話意思</th></tr>
${names.map((n) => `<tr><td>${esc(n)}</td><td>${esc(TERMS[n])}</td></tr>`).join('\n')}
</table><p class="sub">系統畫面上這些名詞旁邊有「?」，點一下也會顯示同樣的說明。</p></section>`;

function pageSection(p, editorView) {
    const pg = PAGES[p];
    const tasks = pg.tasks.filter((t) => editorView || !t.editor);
    if (!tasks.length) return '';
    const legend = (pg.legend || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const faq = (pg.faq || []).filter((f) => editorView || !f[2]).map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('');
    return `
<section class="page">
  <h2>${esc(NAV[p])}　${esc(pg.title)}</h2>
  <p class="intro">${esc(pg.intro)}</p>
  ${(IMAGES[p] || []).filter(() => editorView || p === '/cash-gap-dashboard.html').map(imageHtml).join('')}
  ${legend ? `<h3>看懂畫面</h3><dl>${legend}</dl>` : ''}
  <h3>我想要…</h3>
  ${tasks.map((t) => `
  <div class="task"><h4>${esc(t.q)}${editorView && t.editor ? '<span class="badge">財務人員／管理員</span>' : ''}</h4>
    <ol>${t.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}</div>`).join('')}
  ${faq ? `<h3>常見疑問</h3><dl>${faq}</dl>` : ''}
</section>`;
}

// ---------- 一般同仁 ----------
const viewerOrder = ['/cash-gap-dashboard.html', '/transactions.html', '/financing.html', '/bank-accounts.html', '/settlement.html'];
const viewerBody = `
<section class="card"><h2>三分鐘上手</h2>
  <div class="box"><ol>
    <li>登入後直接進入「⚠️ 資金預估週報」的資金流水帳。第一次進來會有 5 步驟導覽，框出重點給你看。</li>
    <li>先看最上方三個數字：<b>可用資金</b>、<b>目前貸款餘額</b>、兩者相減（藍底＝夠，紅底＝不夠）。</li>
    <li>往下看<b>黃底列</b>（結餘檢查點）：各帳戶預計餘額是否低於安全水位；<b>斜體「（預計）」</b>是推算的預估，不是真實交易。</li>
    <li>想查某筆收支，到「💰 收支記錄」用日期、帳戶、關鍵字查詢。</li>
    <li>看不懂的名詞，點旁邊的「?」；每頁右下角「？ 操作說明」有該頁的使用步驟。</li>
  </ol></div>
  <p class="warn">你的帳號只能查詢，不能新增或修改。發現數字不對，請告訴財務人員：他們會到「收支記錄」或「餘額結算」檢查。</p>
</section>
${viewerOrder.map((p) => pageSection(p, false)).join('')}
${termsTable(['可用資金', '目前貸款餘額', '結餘檢查點', '預計餘額', '安全水位', '資金缺口', '即時餘額', '目前本金餘額', '實際餘額', '差異'])}`;

// ---------- 財務人員 ----------
const financeOrder = ['/cash-gap-dashboard.html', '/transactions.html', '/settlement.html', '/bank-accounts.html', '/financing.html', '/recurring-transactions.html'];
const financeBody = `
<section class="card"><h2>從首頁「現在該做的事」開始</h2>
  <p>登入後首頁最上方會列出<b>現在該處理的事</b>，每一項右邊一個按鈕，直接跳到要操作的頁面，不用自己想要去哪裡。</p>
  ${imageHtml(HOME_IMAGE)}
  <table><tr><th>這一項</th><th>意思</th><th>按下去之後做什麼</th></tr>
    <tr><td>週期範本（含借款還款）</td><td>固定收支或借款還款到期了</td><td>確認實際日期與金額，按「確認入帳」，系統一次記好收支、還款記錄並順延下次日期</td></tr>
    <tr><td>借款「○○」該還款了</td><td>沒有連結範本的借款下次還款日到了</td><td>在還款記錄登記本金與利息</td></tr>
    <tr><td>定存已到期</td><td>定存到期還沒確認</td><td>銀行入帳後按「解約／到期」，利息改成實際金額</td></tr>
    <tr><td>帳戶沒有期初結算／太久沒結算</td><td>系統無法計算餘額，或已超過 35 天沒對帳</td><td>到餘額結算輸入銀行實際餘額</td></tr>
  </table>
</section>
<section class="card"><h2>日常流程</h2>
  <div class="two">
    <div class="box"><h3>第一次建置（只做一次）</h3><ol>
      <li>公司管理：建立公司。</li><li>銀行帳戶：建立帳戶並設定安全水位。</li><li>餘額結算：每個帳戶建「期初餘額」。</li>
      <li>（有借款）借款管理：新增借款，匯入銀行給的還款計畫表。</li><li>（固定支出）週期範本：建立房租、保費、借款還款。</li></ol></div>
    <div class="box"><h3>平常</h3><ol>
      <li><b>每天／每筆：</b>收支記錄「➕ 新增」；很多筆就「📋 貼上匯入」。</li>
      <li><b>固定支出與借款還款：</b>首頁待辦或週期範本按「確認本期入帳」。</li>
      <li><b>月底：</b>餘額結算輸入銀行實際餘額，看差異是否為 0。</li>
      <li><b>存定存／解約：</b>銀行帳戶的「轉定存」「解約／到期」。</li></ol></div>
  </div>
  <p class="warn">記帳最重要的三件事：①公司、帳戶一律從下拉選單選，不要手打；②每個帳戶先建期初結算；③日期早於結算日的收支不會影響目前餘額。</p>
</section>
${financeOrder.map((p) => pageSection(p, true)).join('')}
${termsTable(Object.keys(TERMS))}`;

const outputs = [
    ['快速操作指南-一般同仁.html', '資金週報系統　快速操作指南（一般同仁）', '只要會看就好：找到「我想要…」，照步驟做。每個頁面右下角的「？ 操作說明」是同一份內容。', viewerBody],
    ['快速操作指南-財務人員.html', '資金週報系統　快速操作指南（財務人員）', '從首頁「現在該做的事」開始，照任務卡操作。按鈕與欄位名稱皆採用系統畫面原文。', financeBody]
];
outputs.forEach(([name, title, sub, body]) => {
    const out = path.join(DOCS, WITH_IMAGES ? name.replace('.html', '-含截圖.html') : name);
    fs.writeFileSync(out, doc(title, sub, body));
    console.log('已產生', out, WITH_IMAGES ? '（含截圖）' : '（不含截圖）');
});
