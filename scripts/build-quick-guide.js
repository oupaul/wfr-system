// 產生「快速操作指南」（docs/快速操作指南.html，可直接列印成 PDF）。
// 內容與系統各頁面右下角的「？操作說明」是同一份（public/js/page-help.js 的 PAGES），改一處兩邊同步：
//   node scripts/build-quick-guide.js
const fs = require('fs');
const path = require('path');
const { PAGES } = require('../public/js/page-help.js');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const NAV = {
    '/cash-gap-dashboard.html': '⚠️ 資金預估週報', '/transactions.html': '💰 收支記錄', '/settlement.html': '✅ 餘額結算',
    '/financing.html': '💳 借款管理', '/recurring-transactions.html': '🔁 週期範本', '/bank-accounts.html': '🏦 銀行帳戶'
};
const ORDER = ['/cash-gap-dashboard.html', '/transactions.html', '/settlement.html', '/bank-accounts.html', '/financing.html', '/recurring-transactions.html'];

const quickStart = `
<section class="card quick">
  <h2>三分鐘上手</h2>
  <div class="two">
    <div><h3>一般同仁／主管（只查詢）</h3>
      <ol>
        <li>登入後會直接看到「⚠️ 資金預估週報」的資金流水帳。</li>
        <li>先看最上方三個數字：<b>可用資金</b>、<b>目前貸款餘額</b>、兩者相減（藍底＝夠、紅底＝不夠）。</li>
        <li>往下看<b>黃底列</b>（檢查日）：各帳戶預計餘額是否低於安全水位；斜體「（預計）」是推算，不是真實交易。</li>
        <li>想查某筆收支，到「💰 收支記錄」用日期、帳戶、關鍵字查詢。</li>
      </ol></div>
    <div><h3>財務人員（日常登記）</h3>
      <ol>
        <li><b>第一次建置（只做一次）：</b>公司管理 → 銀行帳戶（含安全水位）→ 餘額結算建「期初餘額」→（有借款）借款管理 →（固定支出）週期範本。</li>
        <li><b>每天／每筆：</b>收支記錄「➕ 新增」，一次很多筆就用「📋 貼上匯入」。</li>
        <li><b>固定支出到期：</b>週期範本按「產生下一筆」，改成實際金額。</li>
        <li><b>借款還款：</b>借款管理「還款記錄」登記本金與利息。</li>
        <li><b>月底：</b>餘額結算輸入銀行實際餘額，看差異是否為 0。</li>
      </ol></div>
  </div>
  <p class="warn">記帳最重要的三件事：①公司、帳戶一律從下拉選單選，不要手打；②每個帳戶先建期初結算；③日期早於結算日的收支不會影響目前餘額。</p>
</section>`;

const index = `
<section class="card">
  <h2>我想要… → 去哪一頁</h2>
  <table>
    <tr><th>我想要</th><th>去哪一頁</th><th>誰可以做</th></tr>
    ${ORDER.flatMap((p) => PAGES[p].tasks.map((t) => `<tr><td>${esc(t.q)}</td><td>${esc(NAV[p])}</td><td>${t.editor ? '財務人員／管理員' : '所有人'}</td></tr>`)).join('\n    ')}
  </table>
</section>`;

const pagesHtml = ORDER.map((p) => {
    const pg = PAGES[p];
    const legend = (pg.legend || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    const tasks = pg.tasks.map((t) => `
      <div class="task">
        <h4>${esc(t.q)}${t.editor ? '<span class="badge">財務人員／管理員</span>' : ''}</h4>
        <ol>${t.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        ${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
      </div>`).join('');
    const faq = (pg.faq || []).map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('');
    return `
<section class="page">
  <h2>${esc(NAV[p])}　${esc(pg.title)}</h2>
  <p class="intro">${esc(pg.intro)}</p>
  ${legend ? `<h3>看懂畫面</h3><dl>${legend}</dl>` : ''}
  <h3>我想要…</h3>
  ${tasks}
  ${faq ? `<h3>常見疑問</h3><dl>${faq}</dl>` : ''}
</section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>資金週報系統 快速操作指南</title>
<style>
  :root { --ink:#1E293B; --muted:#475569; --line:#E2E8F0; --accent:#F06000; --bg:#F8FAFC; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif; color:var(--ink); background:#fff; line-height:1.75; font-size:15px; }
  main { max-width:860px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:28px; margin:8px 0 4px; } .sub { color:var(--muted); margin:0 0 20px; }
  h2 { font-size:21px; margin:0 0 10px; border-bottom:3px solid var(--ink); padding-bottom:6px; }
  h3 { font-size:16px; margin:16px 0 6px; } h4 { font-size:15px; margin:0 0 6px; }
  .card, .page { margin:0 0 28px; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:18px; } @media (max-width:640px){ .two { grid-template-columns:1fr; } }
  .quick .two > div { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:4px 16px 8px; }
  ol { margin:6px 0; padding-left:24px; } li { margin:4px 0; }
  .warn, .note { border-left:4px solid var(--accent); background:#FFF7ED; color:#7C2D12; padding:8px 12px; border-radius:4px; font-size:14px; margin:8px 0; }
  .intro { background:var(--bg); border-left:4px solid var(--ink); padding:10px 14px; border-radius:4px; }
  dl { margin:0; } dt { font-weight:bold; margin-top:8px; } dd { margin:0; color:var(--muted); }
  .task { border:1px solid var(--line); border-radius:8px; padding:10px 14px; margin:10px 0; break-inside:avoid; }
  .badge { font-size:12px; font-weight:normal; background:var(--ink); color:#fff; border-radius:10px; padding:1px 8px; margin-left:8px; }
  table { border-collapse:collapse; width:100%; font-size:14px; } th, td { border:1px solid var(--line); padding:6px 10px; text-align:left; } th { background:var(--bg); }
  @media print { .page { break-before:page; } body { font-size:13px; } main { padding:0; } }
</style></head><body><main>
<h1>資金週報系統　快速操作指南</h1>
<p class="sub">不用從頭讀完：找到「我想要…」，照著步驟做就好。每個頁面右下角的「？ 操作說明」也是同一份內容。按鈕與欄位名稱皆採用系統畫面原文。</p>
${quickStart}
${index}
${pagesHtml}
<p class="sub">借款、定存、報表等較少用的細節請見完整「系統操作手冊」。</p>
</main></body></html>`;

const out = path.join(__dirname, '..', 'docs', '快速操作指南.html');
fs.writeFileSync(out, html);
console.log('已產生', out, `(${Math.round(html.length / 1024)} KB)`);
