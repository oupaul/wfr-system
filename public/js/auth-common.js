/**
 * auth-common.js — 全站共用認證模組
 * 功能：checkAuth、handleLogout、顯示使用者資訊、自動登出提醒
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
        if (url.startsWith('/api/') && !url.includes('/auth/logout')) {
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

    // ==================== 對外暴露 ====================
    window.checkAuth = checkAuth;
    window.handleLogout = handleLogout;
})();
