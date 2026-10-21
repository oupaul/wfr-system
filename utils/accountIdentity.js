// 銀行帳戶的「身分」＝公司名稱＋帳戶名稱＋帳號（空值視為相同）。收支與結算記錄存的是這三項的文字，
// 系統就是用這三項把交易歸到帳戶（見 utils/accountMatch.js），所以兩個啟用中的帳戶身分完全相同時，
// 系統無法區分它們：交易會同時算進兩個帳戶（可用資金被重複計入）、餘額更新只會更新其中一個。
// 典型情況：同一個銀行帳號底下的活存與定存，帳戶名稱也一樣。解法是讓名稱不同（例如加上「定存」）。
const { norm } = require('./accountMatch');

const IDENTITY_HINT = '系統用「公司＋帳戶名稱＋帳號」區分帳戶，兩個完全相同的帳戶無法分辨。若是同一個銀行帳號底下的定存，請把帳戶名稱改成不同（例如加上「定存」）。';

const dbAll = (db, sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r || []))));

const identityKey = (a) => `${norm(a.company_name)}\u0001${norm(a.account_name)}\u0001${norm(a.account_number)}`;

/** 找出與 candidate 身分相同的其他啟用中帳戶（candidate: { company_id, account_name, account_number }） */
async function findIdentityConflict(db, candidate, excludeId = null) {
    const rows = await dbAll(db,
        `SELECT ba.id, ba.account_name, ba.account_number, ba.account_type, ba.bank_name, c.name AS company_name
         FROM bank_accounts ba LEFT JOIN companies c ON c.id = ba.company_id
         WHERE ba.is_active = 1 AND ba.account_name = ? AND IFNULL(ba.account_number, '') = ?
           AND IFNULL(ba.company_id, 0) = IFNULL(?, 0) ${excludeId ? 'AND ba.id <> ?' : ''}
         LIMIT 1`,
        [candidate.account_name, norm(candidate.account_number), candidate.company_id || null, ...(excludeId ? [excludeId] : [])]);
    return rows[0] || null;
}

/** 所有「身分相同」的啟用中帳戶群組（每組 2 個以上） */
async function findDuplicateGroups(db) {
    const rows = await dbAll(db,
        `SELECT ba.id, ba.account_name, ba.account_number, ba.account_type, ba.bank_name, ba.current_balance, ba.created_at, c.name AS company_name
         FROM bank_accounts ba LEFT JOIN companies c ON c.id = ba.company_id WHERE ba.is_active = 1 ORDER BY ba.id`);
    const groups = new Map();
    rows.forEach((r) => { const k = identityKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    return [...groups.values()].filter((g) => g.length > 1);
}

const sameIdentity = (a, b) => identityKey(a) === identityKey(b);

const conflictMessage = (c) => `已有身分相同的啟用中帳戶 #${c.id}（${[c.bank_name, c.account_type].filter(Boolean).join('・') || '帳戶'}）。${IDENTITY_HINT}`;

module.exports = { findIdentityConflict, findDuplicateGroups, sameIdentity, conflictMessage, identityKey, IDENTITY_HINT };
