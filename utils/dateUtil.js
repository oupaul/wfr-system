// 全站統一的「今天」：一律以台北時區（Asia/Taipei）計算，不受伺服器系統時區影響。
//
// 原本有的地方用 new Date().toISOString()（UTC），有的地方用伺服器本機時區：
// 台灣每天 00:00～08:00 之間，UTC 日期還是「昨天」，同一個畫面不同 API 對「今天」的認定
// 就會差一天（例如銀行帳戶管理的即時餘額漏算當天的交易，週報卻算進去）。

function todayInTaipei(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now); // YYYY-MM-DD
}

// 日期字串加減天數（純日期運算，不受時區影響）
function addDaysStr(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

module.exports = { todayInTaipei, addDaysStr };
