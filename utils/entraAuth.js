const { createRemoteJWKSet, jwtVerify } = require('jose');

// 讀取 process.env 一律用 function 而非模組載入當下的 top-level const，
// 因為 server.js 是在 require() 這個檔案「之後」才呼叫 dotenv.config()
// 載入 .env，提早快取值的話會永遠讀到空字串。
const tenantId = () => process.env.ENTRA_TENANT_ID || '';
const clientId = () => process.env.ENTRA_CLIENT_ID || '';

const isConfigured = () => Boolean(tenantId() && clientId());

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

module.exports = { isConfigured, verifyEntraIdToken, tenantId, clientId };
