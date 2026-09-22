const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');
const { requireEditor } = require('../middleware/auth');

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

// 重新計算所有銀行帳戶即時餘額（必須在 /:id 之前）
router.post('/recalculate-balances', async (req, res) => {
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
router.post('/', requireEditor, (req, res) => {
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

    db.run(
        `INSERT INTO bank_accounts 
         (company_id, account_name, account_number, bank_name, branch_name, account_type, currency, safety_level, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [company_id || null, account_name, account_number || null, bank_name || null,
         branch_name || null, account_type || null, currency || 'TWD',
         req.body.safety_level !== undefined ? req.body.safety_level : 0,
         remarks || null, is_active !== undefined ? is_active : 1],
        function(err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, company_id: company_id || null, account_name, account_number: account_number || null, bank_name: bank_name || null, branch_name: branch_name || null, account_type: account_type || null, currency: currency || 'TWD', safety_level: req.body.safety_level !== undefined ? req.body.safety_level : 0, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'bank_account', newId, null, afterData, '銀行帳戶 #' + newId + ' ' + (account_name || ''));
            res.json({ success: true, id: newId, message: '銀行帳戶已新增' });
        }
    );
});

// 更新銀行帳戶
router.put('/:id', requireEditor, (req, res) => {
    const { id } = req.params;
    const { company_id, account_name, account_number, bank_name, branch_name, account_type, currency, remarks, is_active } = req.body;
    const safety_level = req.body.safety_level !== undefined ? req.body.safety_level : 0;
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
                    function(updateErr) {
                        if (updateErr) {
                            logger.error('更新錯誤:', updateErr);
                            return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                        }
                        if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });

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

module.exports = router;
