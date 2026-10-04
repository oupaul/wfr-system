/**
 * auth-common.js — 全站共用認證模組
 * 功能：checkAuth、handleLogout、顯示使用者資訊、自動登出提醒、系統更新通知橫幅、showMessage 訊息提示
 */
(function () {
    'use strict';

    const API_BASE = '/api';
    const SESSION_TIMEOUT_MS = (window.__SESSION_TIMEOUT_MS) || 30 * 60 * 1000; // 預設 30 分鐘
    const WARN_BEFORE_MS = 3 * 60 * 1000; // 提前 3 分鐘警告

    let _warningTimer = null;
    let _logoutTimer = null;
    let _warningShown = false;

    // ==================== 認證檢查 ====================

    /**
     * 檢查登入狀態，未登入則跳轉至登入頁
     * @param {Object} [options]
     * @param {boolean} [options.adminOnly] - 是否只允許管理員進入
     * @param {boolean} [options.editorOnly] - 是否只允許管理員/財務人員進入
     * @returns {Promise<Object|false>} user 物件或 false
     */
    async function checkAuth(options = {}) {
        try {
            const res = await fetch(`${API_BASE}/auth/check`, {
                credentials: 'include',
                cache: 'no-store'
            });
            const result = await res.json();

            if (!result.authenticated) {
                window.location.replace('/login.html?redirect=' + encodeURIComponent(window.location.pathname));
                return false;
            }

            if (options.adminOnly && result.user.role !== 'admin') {
                alert('此頁面需要管理員權限');
                window.location.replace('/index.html');
                return false;
            }

            const isEditorRole = result.user && (result.user.role === 'admin' || result.user.role === 'finance');
            if (options.editorOnly && !isEditorRole) {
                alert('此頁面需要財務人員或管理員權限');
                window.location.replace('/index.html');
                return false;
            }

            // 顯示使用者名稱
            const el = document.getElementById('currentUser');
            if (el && result.user) {
                const roleLabels = { admin: '管理員', finance: '財務人員', user: '一般人員' };
                const roleLabel = roleLabels[result.user.role] || '一般人員';
                el.textContent = `${result.user.full_name || result.user.username} (${roleLabel})`;
            }

            // 非管理員：隱藏導覽列的「人員管理」連結，避免點進去才被擋下來
            if (result.user && result.user.role !== 'admin') {
                document.querySelectorAll('a[href="/users.html"]').forEach((link) => {
                    link.style.display = 'none';
                });
            }

            // 一般使用者：隱藏「週期範本」入口（導覽列連結與頁面上標了 data-editor-only 的元素）
            if (result.user && !isEditorRole) {
                document.querySelectorAll('a[href="/recurring-transactions.html"], [data-editor-only]').forEach((el) => {
                    el.style.display = 'none';
                });
            }

            _startNoticePolling();

            // 啟動自動登出計時器
            _startSessionTimers();

            // 認證確認通過才顯示頁面內容，避免未登入/無權限時先閃過一下原本的畫面才跳轉
            document.body.style.visibility = 'visible';

            return result.user;
        } catch (e) {
            console.error('認證檢查失敗:', e);
            window.location.replace('/login.html?redirect=' + encodeURIComponent(window.location.pathname));
            return false;
        }
    }

    // ==================== 登出 ====================

    async function handleLogout(skipConfirm = false) {
        if (!skipConfirm && !confirm('確定要登出嗎？')) return;
        _clearSessionTimers();
        try {
            await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
        } catch (e) {
            console.error('登出請求失敗:', e);
        }
        window.location.href = '/login.html';
    }

    // ==================== 自動登出計時器 ====================

    function _startSessionTimers() {
        _clearSessionTimers();
        _warningShown = false;

        const warnMs = SESSION_TIMEOUT_MS - WARN_BEFORE_MS;
        if (warnMs > 0) {
            _warningTimer = setTimeout(_showWarning, warnMs);
        }
        _logoutTimer = setTimeout(() => handleLogout(true), SESSION_TIMEOUT_MS);
    }

    function _clearSessionTimers() {
        if (_warningTimer) clearTimeout(_warningTimer);
        if (_logoutTimer) clearTimeout(_logoutTimer);
        _warningTimer = null;
        _logoutTimer = null;
    }

    // 每次使用者互動都重置計時器（透過 API 請求自動更新）
    const _origFetch = window.fetch;
    window.fetch = function (...args) {
        const result = _origFetch.apply(this, args);
        // 只針對同域 API 請求重置計時
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        // 背景輪詢（例如管理員的上線狀態自動更新）不算使用者操作，否則會讓閒置自動登出永遠不觸發
        const isBackgroundPoll = !!(args[1] && args[1].headers && args[1].headers['X-Background-Poll']);
        if (url.startsWith('/api/') && !url.includes('/auth/logout') && !isBackgroundPoll) {
            _resetSessionTimers();
        }
        return result;
    };

    function _resetSessionTimers() {
        if (_logoutTimer) { // 只有已啟動計時器時才重置
            _startSessionTimers();
        }
    }

    function _showWarning() {
        if (_warningShown) return;
        _warningShown = true;

        // 建立警告 overlay
        const overlay = document.createElement('div');
        overlay.id = 'auth-warning-overlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.5);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999; font-family: 'Microsoft JhengHei', Arial, sans-serif;
        `;
        overlay.innerHTML = `
            <div style="background:#fff; border-radius:12px; padding:32px 40px; max-width:360px;
                        text-align:center; box-shadow:0 8px 32px rgba(0,0,0,0.3);">
                <div style="font-size:2.5em; margin-bottom:12px;">⏰</div>
                <h3 style="margin:0 0 12px; color:#333;">即將自動登出</h3>
                <p style="color:#666; margin:0 0 20px;">
                    您已閒置一段時間，將在 <strong id="auth-countdown" style="color:#dc3545;">3:00</strong> 後自動登出。
                </p>
                <div style="display:flex; gap:12px; justify-content:center;">
                    <button id="auth-stay-btn" style="padding:10px 24px; border:none; border-radius:6px;
                        background:#F06000; color:#fff;
                        font-size:15px; cursor:pointer; font-weight:bold;">繼續使用</button>
                    <button id="auth-logout-btn" style="padding:10px 24px; border:none; border-radius:6px;
                        background:#6c757d; color:#fff; font-size:15px; cursor:pointer;">立即登出</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        // 倒數計時顯示
        let remaining = Math.round(WARN_BEFORE_MS / 1000);
        const countdownEl = document.getElementById('auth-countdown');
        const countdownInterval = setInterval(() => {
            remaining--;
            if (remaining <= 0) {
                clearInterval(countdownInterval);
                return;
            }
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            if (countdownEl) countdownEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        }, 1000);

        document.getElementById('auth-stay-btn').addEventListener('click', () => {
            clearInterval(countdownInterval);
            overlay.remove();
            // 呼叫 auth/check 以刷新 server 端 session
            fetch(`${API_BASE}/auth/check`, { credentials: 'include', cache: 'no-store' });
            _startSessionTimers();
        });

        document.getElementById('auth-logout-btn').addEventListener('click', () => {
            clearInterval(countdownInterval);
            handleLogout(true);
        });
    }

    // ==================== 系統更新通知橫幅 ====================
    // 管理員在「人員管理」發佈通知後，所有已登入使用者的每個頁面頂端都會顯示橫幅（含預計更新時間倒數）。
    // 每 60 秒背景檢查一次（帶 X-Background-Poll，不會延後閒置自動登出）；使用者可按「我知道了」暫時收起，
    // 通知內容更新、或距離更新不到 10 分鐘時會再次顯示。
    const NOTICE_POLL_MS = 60 * 1000;
    const NOTICE_URGENT_MS = 10 * 60 * 1000;
    let _noticePollTimer = null;
    let _noticeCountdownTimer = null;
    let _currentNotice = null;

    function _noticeDismissKey(notice, urgent) {
        return 'noticeDismissed:' + notice.created_at + (urgent ? ':urgent' : '');
    }

    function _formatNoticeTime(scheduledAt) {
        // scheduledAt 是台北時間 'YYYY-MM-DDTHH:mm'
        return scheduledAt.replace('T', ' ');
    }

    function _renderNotice() {
        let bar = document.getElementById('system-notice-bar');
        const notice = _currentNotice;
        if (!notice) {
            if (bar) bar.remove();
            return;
        }
        let remainingMs = null;
        if (notice.scheduled_at) {
            remainingMs = Date.parse(notice.scheduled_at + ':00+08:00') - Date.now();
        }
        const urgent = remainingMs !== null && remainingMs <= NOTICE_URGENT_MS;
        let dismissed = false;
        try { dismissed = sessionStorage.getItem(_noticeDismissKey(notice, urgent)) === '1'; } catch (e) { /* 無痕模式等 */ }
        if (dismissed) {
            if (bar) bar.remove();
            return;
        }

        const defaultText = '系統即將進行更新，更新期間可能暫時無法使用，請儘早儲存正在編輯的資料。';
        let timeText = '';
        if (notice.scheduled_at) {
            if (remainingMs > 0) {
                const mins = Math.ceil(remainingMs / 60000);
                const human = mins >= 1440 ? `${Math.floor(mins / 1440)} 天 ${Math.floor((mins % 1440) / 60)} 小時`
                    : mins >= 60 ? `${Math.floor(mins / 60)} 小時 ${mins % 60} 分鐘` : `${mins} 分鐘`;
                timeText = `預計更新時間：${_formatNoticeTime(notice.scheduled_at)}（約 ${human}後）`;
            } else {
                timeText = `預計更新時間：${_formatNoticeTime(notice.scheduled_at)}（更新進行中或即將完成，若頁面異常請稍後重新整理）`;
            }
        }

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'system-notice-bar';
            bar.setAttribute('role', 'status');
            bar.style.cssText = 'position:sticky;top:0;z-index:9000;display:flex;align-items:center;justify-content:center;'
                + 'gap:14px;flex-wrap:wrap;padding:10px 16px;background:#1E293B;color:#fff;font-size:14px;line-height:1.5;'
                + "font-family:'Microsoft JhengHei',Arial,sans-serif;border-bottom:3px solid #F06000;";
            document.body.insertBefore(bar, document.body.firstChild);
        }
        bar.innerHTML = '';
        const text = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = '📢 系統更新通知　';
        text.appendChild(strong);
        text.appendChild(document.createTextNode(notice.message || defaultText));
        bar.appendChild(text);
        if (timeText) {
            const timeEl = document.createElement('span');
            timeEl.textContent = timeText;
            timeEl.style.cssText = 'font-weight:bold;' + (urgent ? 'color:#F06000;background:#fff;padding:1px 8px;border-radius:4px;' : 'color:#F06000;');
            bar.appendChild(timeEl);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '我知道了';
        btn.style.cssText = 'border:1px solid rgba(255,255,255,0.6);background:transparent;color:#fff;border-radius:5px;padding:3px 12px;cursor:pointer;font-size:13px;';
        btn.addEventListener('click', () => {
            try { sessionStorage.setItem(_noticeDismissKey(notice, urgent), '1'); } catch (e) { /* 無法記住就算了，下次輪詢會再出現 */ }
            bar.remove();
        });
        bar.appendChild(btn);
    }

    function _fetchNotice() {
        fetch(`${API_BASE}/notice`, { credentials: 'include', cache: 'no-store', headers: { 'X-Background-Poll': '1' } })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!data) return;
                _currentNotice = data.notice || null;
                _renderNotice();
            })
            .catch(() => { /* 通知抓不到不影響頁面其他功能 */ });
    }

    function _startNoticePolling() {
        if (_noticePollTimer) return; // 每個頁面只啟動一次
        _fetchNotice();
        _noticePollTimer = setInterval(() => { if (!document.hidden) _fetchNotice(); }, NOTICE_POLL_MS);
        // 倒數文字與「快到時間重新顯示」每 30 秒用本地時間刷新一次，不需要再打 API
        _noticeCountdownTimer = setInterval(() => { if (_currentNotice) _renderNotice(); }, 30 * 1000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) _fetchNotice(); });
    }

    // 管理員發佈／撤除通知後，讓目前這頁立刻更新橫幅
    window.refreshSystemNotice = _fetchNotice;

    // ==================== HTML 跳脫（避免使用者輸入內容造成 XSS） ====================

    /**
     * 將字串中的 HTML 特殊字元轉為實體，插入 innerHTML 前務必先經過此函式。
     * 非字串（null/undefined/數字）直接轉成字串處理，避免呼叫端還要另外判斷。
     */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ==================== 頁面訊息（toast） ====================

    let _messageTimer = null;

    /**
     * 在頁面的 #message 區塊顯示訊息，5 秒後自動隱藏。
     * 原本 8 個頁面各自複製一份；#message 的樣式（.error / .success 等）仍由各頁自己定義。
     * @param {string} message - 以純文字顯示（textContent），不會解析 HTML
     * @param {string} [type='error'] - 套用到 #message 的 class（error / success / warning...）
     */
    function showMessage(message, type = 'error') {
        const messageDiv = document.getElementById('message');
        if (!messageDiv) return;
        // 先清掉上一則的計時器，避免連續兩則訊息時，新訊息被前一則的計時器提早收掉
        if (_messageTimer) clearTimeout(_messageTimer);
        messageDiv.className = type;
        messageDiv.textContent = message;
        messageDiv.style.display = 'block';
        _messageTimer = setTimeout(() => {
            messageDiv.style.display = 'none';
            _messageTimer = null;
        }, 5000);
    }

    // ==================== 日期 ====================

    /** 今天（台北時區）YYYY-MM-DD。不用 toISOString()：那是 UTC，台灣 00:00～08:00 會變成昨天 */
    function todayInTaipei() {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    }

    /**
     * 把資料庫／API 回來的時間顯示成台北時間，格式 2026/10/04 17:16:38。
     * SQLite 的 CURRENT_TIMESTAMP 存的是 UTC，字串長得像 '2026-10-04 09:16:38'（沒有時區標記），
     * 直接丟給 new Date() 會被當成瀏覽器本地時間，結果少了 8 小時；這裡明確當成 UTC 再轉台北時間。
     * 帶 Z 或 +08:00 的 ISO 字串、Date 物件則直接轉換。
     */
    function formatDateTime(value) {
        if (!value) return '-';
        let v = value;
        if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v.trim())) {
            v = v.trim().replace(' ', 'T') + 'Z';
        }
        const d = new Date(v);
        if (isNaN(d.getTime())) return String(value);
        return new Intl.DateTimeFormat('zh-TW', {
            timeZone: 'Asia/Taipei',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        }).format(d);
    }

    // ==================== 對外暴露 ====================
    window.checkAuth = checkAuth;
    window.handleLogout = handleLogout;
    window.escapeHtml = escapeHtml;
    window.showMessage = showMessage;
    window.todayInTaipei = todayInTaipei;
    window.formatDateTime = formatDateTime;
})();
