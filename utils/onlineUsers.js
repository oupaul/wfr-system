// 即時上線使用者追蹤（僅存在記憶體，供管理員在「人員管理」頁查看）
//
// session 本身存在 SQLite，但沒有「最後一次動作」的資訊（rolling session 只會延長到期時間），
// 所以在每個已登入的 /api 請求時，用 session id 記下使用者、IP、裝置與最後活動時間。
// - 線上：最後活動在 ONLINE_WINDOW_MS（5 分鐘）內
// - 閒置：超過 5 分鐘，但還沒到 session 逾時（預設 30 分鐘）；超過就視為已離線並移除
// - 服務重啟後記憶體清空，已登入的人下一次操作時會自動重新出現
// 管理員頁面自己的背景輪詢（/api/admin/online-users）不算活動，否則管理員永遠「線上」。

const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT) || 30 * 60 * 1000;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

const entries = new Map(); // sessionID -> { userId, username, role, ip, userAgent, loginAt, lastSeen }

function clientIp(req) {
    return req.headers['cf-connecting-ip'] || req.ip || '';
}

function prune(now = Date.now()) {
    for (const [sid, e] of entries) {
        if (now - e.lastSeen > SESSION_TIMEOUT_MS) entries.delete(sid);
    }
}

// Express middleware：掛在 session 之後、已確認登入的 /api 請求
function trackActivity(req, res, next) {
    const s = req.session;
    if (s && s.userId && req.sessionID && !req.path.startsWith('/admin/online-users')) {
        const now = Date.now();
        const prev = entries.get(req.sessionID);
        entries.set(req.sessionID, {
            userId: s.userId,
            username: s.username,
            role: s.role,
            ip: clientIp(req),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
            loginAt: (prev && prev.loginAt) || s.loginAt || now,
            lastSeen: now
        });
    }
    next();
}

function removeSession(sid) {
    if (sid) entries.delete(sid);
}

function removeUser(userId) {
    for (const [sid, e] of entries) {
        if (e.userId === userId) entries.delete(sid);
    }
}

function describeDevice(ua) {
    const browser = /Edg\//.test(ua) ? 'Edge'
        : /OPR\/|Opera/.test(ua) ? 'Opera'
        : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari' : '其他瀏覽器';
    const os = /Windows/.test(ua) ? 'Windows'
        : /iPhone|iPad/.test(ua) ? 'iOS'
        : /Android/.test(ua) ? 'Android'
        : /Mac OS X/.test(ua) ? 'macOS'
        : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} / ${os}` : browser;
}

// 回傳目前的上線清單（最近活動的在前）；currentSid 是查詢者自己的 session，一律視為線上
function listOnline(currentSid) {
    const now = Date.now();
    prune(now);
    const rows = [];
    for (const [sid, e] of entries) {
        const isSelf = sid === currentSid;
        const lastSeen = isSelf ? now : e.lastSeen;
        rows.push({
            user_id: e.userId,
            username: e.username,
            role: e.role,
            ip: e.ip,
            device: describeDevice(e.userAgent),
            login_at: new Date(e.loginAt).toISOString(),
            last_seen: new Date(lastSeen).toISOString(),
            idle_seconds: Math.floor((now - lastSeen) / 1000),
            status: now - lastSeen <= ONLINE_WINDOW_MS ? 'online' : 'idle',
            is_self: isSelf
        });
    }
    rows.sort((a, b) => a.idle_seconds - b.idle_seconds);
    return rows;
}

module.exports = { trackActivity, removeSession, removeUser, listOnline, ONLINE_WINDOW_MS };
