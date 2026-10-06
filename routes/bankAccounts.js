const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');
const { requireEditor } = require('../middleware/auth');
const { createTransfer } = require('../utils/transfer');
const { todayInTaipei } = require('../utils/dateUtil');
const { estimateInterest } = require('../utils/deposit');

// ==================== 定存（轉定存／解約） ====================
// 定存仍是一般銀行帳戶（帳戶類型「定存」），多了選填的年利率、起存日、到期日、到期轉回的活存帳戶。
// 轉定存、解約都是真實的「帳戶間轉帳」（排除在營業收支統計之外），解約另外把利息記成活存帳戶的收入。
// 未到期的定存會以「（預計）」事件出現在資金預估週報，見 utils/deposit.js。

const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { return err ? reject(err) : resolve(this); }));

const ACCOUNT_WITH_COMPANY_SQL = `SELECT ba.*, c.name AS company_name FROM bank_accounts ba LEFT JOIN companies c ON ba.company_id = c.id WHERE ba.id = ?`;
const isValidDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(`${v}T00:00:00Z`));
const accountRef = (a) => ({ company_name: a.company_name || null, account_name: a.account_name, account_number: a.account_number || null });

// 解析表單送來的定存欄位；沒有帶任何 deposit_* 欄位時回傳 null（代表不要動既有值）
// 帳戶類型不是「定存」時一律清空。回傳 { fields } 或 { error }
async function parseDepositFields(body, accountType, selfId) {
    const keys = ['deposit_interest_rate', 'deposit_start_date', 'deposit_maturity_date', 'deposit_return_account_id'];
    if (!keys.some((k) => body[k] !== undefined)) return null;
    if (accountType !== '定存') {
        return { fields: { rate: null, start: null, maturity: null, returnId: null } };
    }
    const blank = (v) => v === undefined || v === null || v === '';
    let rate = null;
    if (!blank(body.deposit_interest_rate)) {
        rate = Number(body.deposit_interest_rate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { error: '年利率必須是 0～100 之間的數字' };
    }
    const start = blank(body.deposit_start_date) ? null : String(body.deposit_start_date);
    const maturity = blank(body.deposit_maturity_date) ? null : String(body.deposit_maturity_date);
    if (start && !isValidDateStr(start)) return { error: '起存日格式不正確' };
    if (maturity && !isValidDateStr(maturity)) return { error: '到期日格式不正確' };
    if (start && maturity && maturity < start) return { error: '到期日不可早於起存日' };
    let returnId = null;
    if (!blank(body.deposit_return_account_id)) {
        returnId = parseInt(body.deposit_return_account_id, 10);
        if (selfId && returnId === Number(selfId)) return { error: '到期轉回的帳戶不能是定存帳戶本身' };
        const target = await dbGet('SELECT id, is_active FROM bank_accounts WHERE id = ?', [returnId]);
        if (!target || !target.is_active) return { error: '到期轉回的帳戶不存在或已停用' };
    }
    return { fields: { rate, start, maturity, returnId } };
}

function saveDepositFields(id, f) {
    return dbRun(
        `UPDATE bank_accounts SET deposit_interest_rate = ?, deposit_start_date = ?, deposit_maturity_date = ?, deposit_return_account_id = ? WHERE id = ?`,
        [f.rate, f.start, f.maturity, f.returnId, id]
    );
}

// 取得所有銀行帳戶
router.get('/', (req, res) => {
    const { company_id, active } = req.query;
    let query = `
        SELECT ba.*, c.name as company_name 
        FROM bank_accounts ba
        LEFT JOIN companies c ON ba.company_id = c.id
        WHERE 1=1
    `;
    const params = [];

    if (company_id) {
        query += ' AND ba.company_id = ?';
        params.push(company_id);
    }
    if (active !== undefined) {
        query += ' AND ba.is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY ba.account_name ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 已到期但尚未確認解約/到期入帳的定存（週報頁提醒用，僅財務人員／管理員）。必須在 /:id 之前
router.get('/deposits/due', requireEditor, async (req, res) => {
    try {
        const today = todayInTaipei();
        const rows = await new Promise((resolve, reject) => db.all(
            `SELECT ba.id, ba.account_name, ba.deposit_maturity_date, ba.current_balance, c.name AS company_name
             FROM bank_accounts ba LEFT JOIN companies c ON ba.company_id = c.id
             WHERE ba.is_active = 1 AND ba.account_type = '定存'
               AND ba.deposit_maturity_date IS NOT NULL AND ba.deposit_maturity_date <= ?
               AND ba.current_balance > 0
             ORDER BY ba.deposit_maturity_date`, [today], (err, r) => (err ? reject(err) : resolve(r || []))));
        res.json({ data: rows, count: rows.length });
    } catch (err) {
        logger.error('查詢到期定存錯誤:', err);
        res.status(500).json({ error: '查詢失敗', details: err.message });
    }
});

// 重新計算所有銀行帳戶即時餘額（必須在 /:id 之前）
router.post('/recalculate-balances', requireEditor, async (req, res) => {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT ba.account_name, ba.account_number, c.name as company_name
                FROM bank_accounts ba
                LEFT JOIN companies c ON ba.company_id = c.id
                WHERE ba.is_active = 1
            `, [], (err, r) => err ? reject(err) : resolve(r || []));
        });
        for (const row of rows) {
            await updateBankAccountBalance(row.account_name, row.account_number, row.company_name || null);
        }
        res.json({ success: true, message: `已重新計算 ${rows.length} 個帳戶餘額` });
    } catch (err) {
        logger.error('重新計算餘額錯誤:', err);
        res.status(500).json({ error: '重新計算失敗', details: err.message });
    }
});

// 取得單一銀行帳戶
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get(
        `SELECT ba.*, c.name as company_name 
         FROM bank_accounts ba
         LEFT JOIN companies c ON ba.company_id = c.id
         WHERE ba.id = ?`,
        [id],
        (err, row) => {
            if (err) {
                logger.error('查詢錯誤:', err);
                return res.status(500).json({ error: '查詢失敗', details: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            res.json({ data: row });
        }
    );
});

// 新增銀行帳戶
router.post('/', requireEditor, async (req, res) => {
    const {
        company_id,
        account_name,
        account_number,
        bank_name,
        branch_name,
        account_type,
        currency,
        remarks,
        is_active
    } = req.body;

    if (!account_name) {
        return res.status(400).json({ error: 'account_name 為必填欄位' });
    }
    let depositParsed;
    try {
        depositParsed = await parseDepositFields(req.body, account_type, null);
    } catch (e) {
        return res.status(500).json({ error: '新增失敗', details: e.message });
    }
    if (depositParsed && depositParsed.error) return res.status(400).json({ error: depositParsed.error });

    db.run(
        `INSERT INTO bank_accounts 
         (company_id, account_name, account_number, bank_name, branch_name, account_type, currency, safety_level, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_id || null, account_name, account_number || null, bank_name || null,
         branch_name || null, account_type || null, currency || 'TWD',
         req.body.safety_level !== undefined ? req.body.safety_level : 0,
         remarks || null, is_active !== undefined ? is_active : 1],
        async function(err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            if (depositParsed) await saveDepositFields(newId, depositParsed.fields).catch((e) => logger.error('儲存定存欄位失敗:', e));
            const afterData = { id: newId, company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level: req.body.safety_level !== undefined ? req.body.safety_level : 0, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'bank_account', newId, null, afterData, '銀行帳戶 #' + newId + ' ' + (account_name || ''));
            res.json({ success: true, id: newId, message: '銀行帳戶已新增' });
        }
    );
});

// 更新銀行帳戶
router.put('/:id', requireEditor, async (req, res) => {
    const { id } = req.params;
    const { company_id, account_name, account_number, bank_name, branch_name, account_type, currency, remarks, is_active } = req.body;
    const safety_level = req.body.safety_level !== undefined ? req.body.safety_level : 0;
    let depositParsed;
    try {
        depositParsed = await parseDepositFields(req.body, account_type, id);
    } catch (e) {
        return res.status(500).json({ error: '更新失敗', details: e.message });
    }
    if (depositParsed && depositParsed.error) return res.status(400).json({ error: depositParsed.error });
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }

        // 收支記錄／結算記錄存的是當下複製的 company_name/account_name/account_number
        // 文字，不是外鍵；改帳戶名稱、帳號或所屬公司前，先查出新舊公司名稱，更新
        // bank_accounts 後一併把既有收支/結算記錄的對應文字欄位改過去，避免資金流水
        // 帳等計算用「新名稱」比對「舊文字」而找不到資料、悄悄少算的問題。
        db.get('SELECT name FROM companies WHERE id = ?', [oldRow.company_id], (oldCompanyErr, oldCompanyRow) => {
            if (oldCompanyErr) {
                logger.error('查詢原公司名稱失敗:', oldCompanyErr);
                return res.status(500).json({ error: '更新失敗', details: oldCompanyErr.message });
            }
            const oldCompanyName = oldCompanyRow ? oldCompanyRow.name : null;

            db.get('SELECT name FROM companies WHERE id = ?', [company_id || null], (newCompanyErr, newCompanyRow) => {
                if (newCompanyErr) {
                    logger.error('查詢新公司名稱失敗:', newCompanyErr);
                    return res.status(500).json({ error: '更新失敗', details: newCompanyErr.message });
                }
                const newCompanyName = newCompanyRow ? newCompanyRow.name : oldCompanyName;

                const afterData = { id: parseInt(id, 10), company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
                db.run(
                    `UPDATE bank_accounts SET company_id = ?, account_name = ?, account_number = ?, bank_name = ?, branch_name = ?, account_type = ?, currency = ?, safety_level = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [company_id || null, account_name, account_number || null, bank_name || null, branch_name || null, account_type || null, currency || 'TWD', safety_level, remarks || null, is_active !== undefined ? is_active : 1, id],
                    async function(updateErr) {
                        if (updateErr) {
                            logger.error('更新錯誤:', updateErr);
                            return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                        }
                        if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                        if (depositParsed) await saveDepositFields(id, depositParsed.fields).catch((e) => logger.error('儲存定存欄位失敗:', e));

                        const identityChanged = oldCompanyName !== newCompanyName
                            || oldRow.account_name !== account_name
                            || (oldRow.account_number || null) !== (account_number || null);

                        const finish = () => {
                            writeOperationLog(req, 'update', 'bank_account', id, oldRow, afterData, '銀行帳戶 #' + id + ' ' + (account_name || ''));
                            res.json({ success: true, message: '銀行帳戶已更新' });
                        };

                        if (!identityChanged || !oldCompanyName) {
                            return finish();
                        }

                        const matchWhere = `company_name = ? AND account_name = ? AND (account_number = ? OR (account_number IS NULL AND ? IS NULL))`;
                        const matchParams = [oldCompanyName, oldRow.account_name, oldRow.account_number || null, oldRow.account_number || null];
                        const setParams = [newCompanyName, account_name, account_number || null];

                        db.run(
                            `UPDATE transactions SET company_name = ?, account_name = ?, account_number = ? WHERE ${matchWhere}`,
                            [...setParams, ...matchParams],
                            function(txnErr) {
                                if (txnErr) logger.error('同步收支記錄帳戶資訊失敗:', txnErr);
                                db.run(
                                    `UPDATE balance_settlements SET company_name = ?, account_name = ?, account_number = ? WHERE ${matchWhere}`,
                                    [...setParams, ...matchParams],
                                    function(settleErr) {
                                        if (settleErr) logger.error('同步結算記錄帳戶資訊失敗:', settleErr);
                                        finish();
                                    }
                                );
                            }
                        );
                    }
                );
            });
        });
    });
});

// 刪除銀行帳戶
// financing.bank_account_id 是真正的數字外鍵（不像 transactions/settlements 用複製
// 的文字比對），這個專案又沒開 PRAGMA foreign_keys，刪除前沒檢查的話，刪掉帳戶會
// 讓借款留著一個指向不存在資料的 ID：借款列表該筆會悄悄顯示空白、資金流水帳/
// 資金缺口的還款投影也會沒有任何警示地消失。刪除前先擋下來，讓使用者自己決定
// 要先改掉借款的撥款/還款帳戶設定，還是連借款一起處理。
router.delete('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM bank_accounts WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.all(`SELECT account_name FROM bank_accounts WHERE deposit_return_account_id = ?`, [id], (depErr, depositRows) => {
          if (depErr) {
              logger.error('查詢關聯定存錯誤:', depErr);
              return res.status(500).json({ error: '刪除失敗', details: depErr.message });
          }
          if (depositRows && depositRows.length > 0) {
              return res.status(400).json({
                  error: `此帳戶被定存「${depositRows.map(d => d.account_name).slice(0, 3).join('、')}」設為到期轉回帳戶，請先修改那些定存的轉回帳戶，再刪除此帳戶。`
              });
          }
        db.all('SELECT facility_name FROM financing WHERE bank_account_id = ?', [id], (finErr, financingRows) => {
            if (finErr) {
                logger.error('查詢關聯借款錯誤:', finErr);
                return res.status(500).json({ error: '刪除失敗', details: finErr.message });
            }
            if (financingRows && financingRows.length > 0) {
                const names = financingRows.slice(0, 3).map(f => f.facility_name).join('、');
                const more = financingRows.length > 3 ? ` 等共 ${financingRows.length} 筆` : '';
                return res.status(400).json({
                    error: `此銀行帳戶仍被借款「${names}」${more}設為撥款/還款帳戶，請先到借款管理修改這些借款的撥款/還款帳戶，或刪除這些借款，再刪除此帳戶。`
                });
            }
            db.run('DELETE FROM bank_accounts WHERE id = ?', [id], function(delErr) {
                if (delErr) {
                    logger.error('刪除錯誤:', delErr);
                    return res.status(500).json({ error: '刪除失敗', details: delErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'delete', 'bank_account', id, row, null, '銀行帳戶 #' + id + ' ' + (row.account_name || ''));
                res.json({ success: true, message: '銀行帳戶已刪除' });
            });
        });
        });
    });
});

// 定存解約／到期的預覽：回傳目前本金（餘額）與依年利率估算的利息，供確認視窗預填
router.get('/:id/deposit-estimate', requireEditor, async (req, res) => {
    try {
        const dep = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [req.params.id]);
        if (!dep) return res.status(404).json({ error: '找不到記錄' });
        if (dep.account_type !== '定存') return res.status(400).json({ error: '這不是定存帳戶' });
        await updateBankAccountBalance(dep.account_name, dep.account_number, dep.company_name || null);
        const fresh = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [req.params.id]);
        const date = isValidDateStr(req.query.date) ? req.query.date : todayInTaipei();
        const principal = Math.max(0, parseFloat(fresh.current_balance) || 0);
        res.json({
            principal,
            interest: estimateInterest(principal, fresh.deposit_interest_rate, fresh.deposit_start_date, date),
            interest_rate: fresh.deposit_interest_rate,
            start_date: fresh.deposit_start_date,
            maturity_date: fresh.deposit_maturity_date,
            return_account_id: fresh.deposit_return_account_id
        });
    } catch (err) {
        logger.error('定存利息估算錯誤:', err);
        res.status(500).json({ error: '查詢失敗', details: err.message });
    }
});

// 轉定存：從活存（:id）轉出一筆到定存帳戶（既有的，或當場新增一個）。
// body: { date, amount, to_account_id | new_account: { account_name, account_number?, bank_name? },
//         interest_rate?, maturity_date?, remarks? }
router.post('/:id/deposit-open', requireEditor, async (req, res) => {
    let createdAccountId = null;
    try {
        const { date, amount, to_account_id, new_account, interest_rate, maturity_date, remarks } = req.body;
        const source = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [req.params.id]);
        if (!source || !source.is_active) return res.status(404).json({ error: '找不到啟用中的來源帳戶' });
        if (source.account_type === '定存') return res.status(400).json({ error: '請從活存等非定存帳戶轉出' });
        if (!isValidDateStr(date)) return res.status(400).json({ error: '存入日期格式不正確' });
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: '金額必須大於 0' });

        const deposit = await parseDepositFields({
            deposit_interest_rate: interest_rate, deposit_start_date: date,
            deposit_maturity_date: maturity_date, deposit_return_account_id: source.id
        }, '定存', null);
        if (deposit.error) return res.status(400).json({ error: deposit.error });

        let dest;
        if (to_account_id) {
            dest = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [to_account_id]);
            if (!dest || !dest.is_active) return res.status(400).json({ error: '找不到啟用中的定存帳戶' });
            if (dest.account_type !== '定存') return res.status(400).json({ error: '轉入的帳戶必須是定存帳戶' });
            if ((dest.company_id || null) !== (source.company_id || null)) return res.status(400).json({ error: '定存帳戶必須與來源帳戶屬於同一家公司' });
            if (dest.id === source.id) return res.status(400).json({ error: '轉入與轉出不能是同一個帳戶' });
            await updateBankAccountBalance(dest.account_name, dest.account_number, dest.company_name || null);
            const destFresh = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [dest.id]);
            if ((parseFloat(destFresh.current_balance) || 0) > 0.005) {
                // 每筆定存的到期日與利率都記在帳戶上，已有餘額的帳戶再轉入會讓不同期限的錢混在一起
                return res.status(400).json({ error: `定存「${dest.account_name}」目前已有餘額，請另外新增一個定存帳戶（解約後餘額歸零的定存帳戶可以重複使用），避免不同期限混在一起。` });
            }
        } else if (new_account && new_account.account_name && String(new_account.account_name).trim()) {
            const name = String(new_account.account_name).trim();
            const number = String(new_account.account_number || '').trim();
            const dup = await dbGet(
                `SELECT id FROM bank_accounts WHERE account_name = ? AND IFNULL(company_id, 0) = IFNULL(?, 0) AND IFNULL(account_number, '') = ?`,
                [name, source.company_id || null, number]);
            if (dup) return res.status(400).json({ error: '已有同公司、同名稱、同帳號的帳戶，請改名或直接選用它' });
            const ins = await dbRun(
                `INSERT INTO bank_accounts (company_id, account_name, account_number, bank_name, account_type, currency, safety_level, is_active)
                 VALUES (?, ?, ?, ?, '定存', ?, 0, 1)`,
                [source.company_id || null, name, number || null, String(new_account.bank_name || source.bank_name || '').trim() || null, source.currency || 'TWD']);
            createdAccountId = ins.lastID;
            writeOperationLog(req, 'create', 'bank_account', createdAccountId, null,
                { id: createdAccountId, company_id: source.company_id || null, account_name: name, account_number: number || null, account_type: '定存' },
                '銀行帳戶 #' + createdAccountId + ' ' + name + '（轉定存時新增）');
            dest = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [createdAccountId]);
        } else {
            return res.status(400).json({ error: '請選擇定存帳戶，或填寫要新增的定存帳戶名稱' });
        }

        const { fromId, toId } = await createTransfer(req, {
            date, amount: amt, from: accountRef(source), to: accountRef(dest), category: '轉定存', remarks,
            fromDescription: `轉入定存 ${dest.account_name}`, toDescription: `定存存入（來自 ${source.account_name}）`
        });
        await saveDepositFields(dest.id, deposit.fields);
        writeOperationLog(req, 'update', 'bank_account', dest.id, { deposit: null }, { deposit_interest_rate: deposit.fields.rate, deposit_start_date: deposit.fields.start, deposit_maturity_date: deposit.fields.maturity, deposit_return_account_id: deposit.fields.returnId }, `定存 ${dest.account_name} 存入 ${amt}`);
        res.json({ success: true, fromId, toId, to_account_id: dest.id, message: `已轉入定存「${dest.account_name}」${amt.toLocaleString('en-US')} 元` });
    } catch (err) {
        if (createdAccountId) {
            // 轉帳失敗就把剛新增的空定存帳戶一併移除
            db.run('DELETE FROM bank_accounts WHERE id = ?', [createdAccountId], () => {});
        }
        logger.error('轉定存錯誤:', err);
        res.status(500).json({ error: '轉定存失敗', details: err.message });
    }
});

// 解約／到期：定存（:id）轉回活存，並把利息記成活存帳戶的收入。
// body: { date(不可晚於今天), principal?, interest?, to_account_id?(預設用設定的轉回帳戶), remarks? }
// 本金等於全部餘額時清空定存欄位（這筆定存結束）；只解約一部分則保留到期日與利率。
router.post('/:id/deposit-close', requireEditor, async (req, res) => {
    try {
        const { date, principal, interest, to_account_id, remarks } = req.body;
        const dep = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [req.params.id]);
        if (!dep) return res.status(404).json({ error: '找不到記錄' });
        if (dep.account_type !== '定存') return res.status(400).json({ error: '這不是定存帳戶' });
        if (!isValidDateStr(date)) return res.status(400).json({ error: '解約／到期日期格式不正確' });
        if (date > todayInTaipei()) return res.status(400).json({ error: '解約／到期日期不可晚於今天；尚未到期前，預測會自動帶入預計轉回，不需要先登記' });

        await updateBankAccountBalance(dep.account_name, dep.account_number, dep.company_name || null);
        const fresh = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [req.params.id]);
        const balance = parseFloat(fresh.current_balance) || 0;
        if (balance <= 0.005) return res.status(400).json({ error: '這個定存帳戶目前沒有餘額可以轉回' });

        const prin = principal === undefined || principal === null || principal === '' ? balance : Number(principal);
        if (!Number.isFinite(prin) || prin <= 0) return res.status(400).json({ error: '轉回本金必須大於 0' });
        if (prin > balance + 0.005) return res.status(400).json({ error: `轉回本金不可超過目前餘額 ${balance.toLocaleString('en-US')}` });
        const intr = interest === undefined || interest === null || interest === '' ? 0 : Number(interest);
        if (!Number.isFinite(intr) || intr < 0) return res.status(400).json({ error: '利息必須是大於或等於 0 的數字' });

        const targetId = to_account_id || fresh.deposit_return_account_id;
        if (!targetId) return res.status(400).json({ error: '請選擇要轉回的活存帳戶' });
        const target = await dbGet(ACCOUNT_WITH_COMPANY_SQL, [targetId]);
        if (!target || !target.is_active) return res.status(400).json({ error: '轉回的帳戶不存在或已停用' });
        if (target.id === fresh.id) return res.status(400).json({ error: '轉回的帳戶不能是定存帳戶本身' });

        const atMaturity = fresh.deposit_maturity_date && date >= fresh.deposit_maturity_date;
        const kind = atMaturity ? '定存到期' : '定存解約';
        const { fromId, toId } = await createTransfer(req, {
            date, amount: prin, from: accountRef(fresh), to: accountRef(target), category: kind, remarks,
            fromDescription: `${kind}轉出至 ${target.account_name}`, toDescription: `${kind}轉入（來自 ${fresh.account_name}）`
        });

        let interestId = null;
        if (intr > 0) {
            const ins = await dbRun(
                `INSERT INTO transactions (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks)
                 VALUES (?, 'income', ?, '利息收入', ?, ?, ?, ?, ?)`,
                [date, intr, `定存利息（${fresh.account_name}）`, target.company_name || null, target.account_name, target.account_number || null, remarks || null]);
            interestId = ins.lastID;
            writeOperationLog(req, 'create', 'transaction', interestId, null,
                { id: interestId, transaction_date: date, type: 'income', amount: intr, category: '利息收入', account_name: target.account_name },
                `定存利息 #${interestId} ${fresh.account_name} → ${target.account_name}`);
            await updateBankAccountBalance(target.account_name, target.account_number, target.company_name || null);
        }

        const ended = prin >= balance - 0.005;
        if (ended) {
            await saveDepositFields(fresh.id, { rate: null, start: null, maturity: null, returnId: null });
        }
        writeOperationLog(req, 'update', 'bank_account', fresh.id,
            { deposit_maturity_date: fresh.deposit_maturity_date, balance },
            { closed: ended, principal: prin, interest: intr },
            `${kind} ${fresh.account_name}：本金 ${prin}、利息 ${intr}`);
        res.json({
            success: true, fromId, toId, interestId, ended,
            message: `${kind}完成：本金 ${prin.toLocaleString('en-US')} 元轉回「${target.account_name}」`
                + (intr > 0 ? `，利息 ${intr.toLocaleString('en-US')} 元已記為收入` : '')
                + (ended ? '' : `（部分解約，定存帳戶尚有 ${(balance - prin).toLocaleString('en-US')} 元）`)
        });
    } catch (err) {
        logger.error('定存解約錯誤:', err);
        res.status(500).json({ error: '解約失敗', details: err.message });
    }
});

module.exports = router;
