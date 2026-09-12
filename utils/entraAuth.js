const { createRemoteJWKSet, jwtVerify } = require('jose');
const { db } = require('../database/db');

// 讀取設定的順序：資料庫（管理者在後台設定過）優先，其次才是 .env。
// 資料庫尚未被設定過（從未在後台存過）時，dbHasOverride 為 false，
// 完全 fallback 回 .env，維持既有只用 .env 部署的行為不變。
let dbHasOverride = false;
let cachedTenantId = '';
let cachedClientId = '';

function init() {
    return new Promise((resolve) => {
        db.all(
            "SELECT key, value FROM system_settings WHERE key IN ('entra_tenant_id', 'entra_client_id')",
            [],
            (err, rows) => {
                if (!err && rows && rows.length > 0) {
                    rows.forEach((r) => {
                        if (r.key === 'entra_tenant_id') cachedTenantId = r.value || '';
                        if (r.key === 'entra_client_id') cachedClientId = r.value || '';
                    });
                    dbHasOverride = true;
                }
                resolve();
            }
        );
    });
}

function tenantId() {
    if (dbHasOverride) return cachedTenantId;
    return process.env.ENTRA_TENANT_ID || '';
}

function clientId() {
    if (dbHasOverride) return cachedClientId;
    return process.env.ENTRA_CLIENT_ID || '';
}

const isConfigured = () => Boolean(tenantId() && clientId());

// 管理者在後台儲存設定：立即更新資料庫與記憶體快取，不需要重啟服務
function saveSettings(newTenantId, newClientId) {
    return new Promise((resolve, reject) => {
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO system_settings (key, value, updated_at) VALUES ('entra_tenant_id', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [newTenantId || '', now],
            (err) => {
                if (err) return reject(err);
                db.run(
                    `INSERT INTO system_settings (key, value, updated_at) VALUES ('entra_client_id', ?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
                    [newClientId || '', now],
                    (err2) => {
                        if (err2) return reject(err2);
                        cachedTenantId = newTenantId || '';
                        cachedClientId = newClientId || '';
                        dbHasOverride = true;
                        jwks = null;
                        jwksTenantId = null;
                        resolve();
                    }
                );
            }
        );
    });
}

let jwks = null;
let jwksTenantId = null;
function getJwks() {
    if (!jwks || jwksTenantId !== tenantId()) {
        jwksTenantId = tenantId();
        jwks = createRemoteJWKSet(
            new URL(`https://login.microsoftonline.com/${jwksTenantId}/discovery/v2.0/keys`)
        );
    }
    return jwks;
}

// 驗證前端 MSAL 取得的 Entra ID token，回傳其中的 email（找不到就回傳 null）
async function verifyEntraIdToken(idToken) {
    if (!isConfigured()) {
        throw new Error('SSO 尚未設定 ENTRA_TENANT_ID / ENTRA_CLIENT_ID');
    }

    const { payload } = await jwtVerify(idToken, getJwks(), {
        issuer: `https://login.microsoftonline.com/${tenantId()}/v2.0`,
        audience: clientId()
    });

    const email = payload.preferred_username || payload.email || null;
    return { email: email ? String(email).toLowerCase() : null, payload };
}

module.exports = {
    init,
    isConfigured,
    verifyEntraIdToken,
    saveSettings,
    tenantId,
    clientId,
    isOverriddenInDb: () => dbHasOverride,
    envHasValue: () => Boolean(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID)
};
