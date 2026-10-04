// 「公司 → 該公司銀行帳戶」下拉選單的共用載入邏輯。
// 原本每個頁面各自複製一份「fetch → 組 <option> → 填進 <select>」，函式與變數名稱各異，
// 同一個 bug 要修好幾遍；這裡集中成單一實作，頁面只負責自己的快取變數與 onchange 連動。
// 比照 auth-common.js 的做法：純 <script src> 引入，掛在 window 上，不需要 build。
// 需要先載入 auth-common.js（使用其 escapeHtml）。
(function () {
    const API_BASE = '/api';

    // 帳戶選項文字：帳戶名稱 (銀行 - 類型) - 帳號 - 公司
    // showCompany：true 一律附上公司名稱；false 不附（已經用公司篩選過、不需要重複）
    function buildAccountLabel(a, showCompany = true) {
        const bankAndType = [a.bank_name, a.account_type].filter(Boolean).join(' - ');
        return `${escapeHtml(a.account_name)}`
            + `${bankAndType ? ' (' + escapeHtml(bankAndType) + ')' : ''}`
            + `${a.account_number ? ' - ' + escapeHtml(a.account_number) : ''}`
            + `${showCompany && a.company_name ? ' - ' + escapeHtml(a.company_name) : ''}`;
    }

    // 載入啟用中的公司並填入 selectEl。
    // options.placeholder：第一個空白選項文字；options.valueKey：option value 用 'id'（預設）或 'name'
    // 回傳 Promise<公司陣列 | null>，永遠 resolve（失敗回 null、不動 select），呼叫端不需要另外 .catch
    function loadCompanies(selectEl, options = {}) {
        const placeholder = options.placeholder !== undefined ? options.placeholder : '請選擇公司';
        const valueKey = options.valueKey || 'id';
        return fetch(`${API_BASE}/companies?active=true`)
            .then((res) => res.json())
            .then((data) => {
                if (data.error) return null;
                const list = data.data || [];
                if (selectEl) {
                    const keep = selectEl.value;
                    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`
                        + list.map((c) => `<option value="${escapeHtml(String(c[valueKey]))}">${escapeHtml(c.name)}</option>`).join('');
                    if (options.keepSelection) selectEl.value = keep;
                }
                return list;
            })
            .catch((err) => {
                console.error('載入公司列表錯誤:', err);
                return null;
            });
    }

    // 載入啟用中的銀行帳戶（可只載入某家公司的）並填入 selectEl（selectEl 可省略，只要資料）。
    // options.placeholder：第一個空白選項文字
    // options.showCompany：選項文字要不要附公司名稱（預設 true；有指定 companyId 時可傳 false）
    // options.accountNumberAttr：true 時每個 option 帶 data-account-number
    // 回傳 Promise<帳戶陣列 | null>，永遠 resolve
    function loadAccounts(selectEl, companyId, options = {}) {
        const placeholder = options.placeholder !== undefined ? options.placeholder : '請選擇帳戶';
        const showCompany = options.showCompany !== undefined ? options.showCompany : true;
        let url = `${API_BASE}/bank-accounts?active=true`;
        if (companyId) url += `&company_id=${companyId}`;
        return fetch(url)
            .then((res) => res.json())
            .then((data) => {
                if (data.error) return null;
                const list = data.data || [];
                if (selectEl) {
                    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`
                        + list.map((a) => {
                            const numberAttr = options.accountNumberAttr
                                ? ` data-account-number="${escapeHtml(a.account_number || '')}"` : '';
                            return `<option value="${a.id}"${numberAttr}>${buildAccountLabel(a, showCompany)}</option>`;
                        }).join('');
                }
                return list;
            })
            .catch((err) => {
                console.error('載入銀行帳戶列表錯誤:', err);
                return null;
            });
    }

    window.AccountSelect = { buildAccountLabel, loadCompanies, loadAccounts };
})();
