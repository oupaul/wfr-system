// 資金預估週報的「結餘檢查日」：每家公司可自訂每月的哪幾號（預設 15、30）。
//
// - 存在 companies.check_days，格式是逗號分隔的日期數字，例如 "5,20" 或 "10,25,31"；NULL 代表用預設 15、30
// - 1～31，31 代表月底；當月沒有那一天（例如 2 月的 30、31）自動取該月最後一天，同月重複的日期只留一個
// - 沒有所屬公司的帳戶一律用預設

const DEFAULT_CHECK_DAYS = [15, 30];
const MAX_CHECK_DAYS = 6;

// 解析使用者輸入（字串或陣列）。回傳 { days: 排序去重後的陣列 | null(=用預設), error?: string }
function parseCheckDays(raw) {
    if (raw === undefined || raw === null) return { days: null };
    const parts = Array.isArray(raw) ? raw : String(raw).split(/[,，、\s]+/);
    const tokens = parts.map((p) => String(p).trim()).filter((p) => p !== '');
    if (tokens.length === 0) return { days: null };
    const days = [];
    for (const t of tokens) {
        if (!/^\d{1,2}$/.test(t)) return { error: `檢查日「${t}」不是有效的數字` };
        const n = parseInt(t, 10);
        if (n < 1 || n > 31) return { error: `檢查日必須介於 1～31（目前是 ${n}）` };
        if (!days.includes(n)) days.push(n);
    }
    if (days.length > MAX_CHECK_DAYS) return { error: `檢查日最多設定 ${MAX_CHECK_DAYS} 個` };
    days.sort((a, b) => a - b);
    return { days };
}

// 這個帳戶適用的檢查日（取所屬公司的設定，沒有或設定異常就用預設）
function getAccountCheckDays(account) {
    const parsed = parseCheckDays(account && account.company_check_days);
    return parsed.days && !parsed.error ? parsed.days : DEFAULT_CHECK_DAYS;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

// 從 todayStr（YYYY-MM-DD）所在月份開始往後 monthsAhead 個月，列出落在今天（含）之後的檢查日。
// 當月天數不足時取該月最後一天，避免日期滾到下個月。回傳排序、去重的 YYYY-MM-DD 陣列。
function buildCheckDates(days, monthsAhead, todayStr) {
    const [ty, tm] = todayStr.split('-').map(Number);
    const out = new Set();
    for (let i = 0; i < monthsAhead; i++) {
        const monthIndex = (tm - 1) + i;
        const y = ty + Math.floor(monthIndex / 12);
        const m = ((monthIndex % 12) + 12) % 12; // 0-based
        const lastDay = new Date(y, m + 1, 0).getDate();
        days.forEach((d) => {
            const date = `${y}-${pad(m + 1)}-${pad(Math.min(d, lastDay))}`;
            if (date >= todayStr) out.add(date);
        });
    }
    return Array.from(out).sort();
}

module.exports = { DEFAULT_CHECK_DAYS, MAX_CHECK_DAYS, parseCheckDays, getAccountCheckDays, buildCheckDates };
