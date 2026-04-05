const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');

// 取得所有公司
router.get('/', (req, res) => {
    const { active } = req.query;
    let query = 'SELECT * FROM companies WHERE 1=1';
    const params = [];

    if (active !== undefined) {
        query += ' AND is_active = ?';
        params.push(active === 'true' ? 1 : 0);
    }

    query += ' ORDER BY name ASC';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 取得單一公司
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        res.json({ data: row });
    });
});

// 新增公司
router.post('/', (req, res) => {
    const {
        name,
        code,
        contact_person,
        contact_phone,
        contact_email,
        address,
        remarks,
        is_active
    } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'name 為必填欄位' });
    }

    db.run(
        `INSERT INTO companies 
         (name, code, contact_person, contact_phone, contact_email, address, remarks, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, code || null, contact_person || null, contact_phone || null,
         contact_email || null, address || null, remarks || null, is_active !== undefined ? is_active : 1],
        function(err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }
            const newId = this.lastID;
            const afterData = { id: newId, name, code: code || null, contact_person: contact_person || null, contact_phone: contact_phone || null, contact_email: contact_email || null, address: address || null, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
            writeOperationLog(req, 'create', 'company', newId, null, afterData, '公司 #' + newId + ' ' + (name || ''));
            res.json({ success: true, id: newId, message: '公司已新增' });
        }
    );
});

// 更新公司
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const { name, code, contact_person, contact_phone, contact_email, address, remarks, is_active } = req.body;
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, oldRow) => {
        if (err || !oldRow) {
            if (!oldRow) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '更新失敗', details: err && err.message });
        }
        const afterData = { id: parseInt(id, 10), name, code: code || null, contact_person: contact_person || null, contact_phone: contact_phone || null, contact_email: contact_email || null, address: address || null, remarks: remarks || null, is_active: is_active !== undefined ? is_active : 1 };
        db.run(
            `UPDATE companies SET name = ?, code = ?, contact_person = ?, contact_phone = ?, contact_email = ?, address = ?, remarks = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [name, code || null, contact_person || null, contact_phone || null, contact_email || null, address || null, remarks || null, is_active !== undefined ? is_active : 1, id],
            function(updateErr) {
                if (updateErr) {
                    logger.error('更新錯誤:', updateErr);
                    return res.status(500).json({ error: '更新失敗', details: updateErr.message });
                }
                if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
                writeOperationLog(req, 'update', 'company', id, oldRow, afterData, '公司 #' + id + ' ' + (name || ''));
                res.json({ success: true, message: '公司已更新' });
            }
        );
    });
});

// 刪除公司
router.delete('/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM companies WHERE id = ?', [id], (err, row) => {
        if (err || !row) {
            if (!row) return res.status(404).json({ error: '找不到記錄' });
            return res.status(500).json({ error: '刪除失敗', details: err && err.message });
        }
        db.run('DELETE FROM companies WHERE id = ?', [id], function(delErr) {
            if (delErr) {
                logger.error('刪除錯誤:', delErr);
                return res.status(500).json({ error: '刪除失敗', details: delErr.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: '找不到記錄' });
            writeOperationLog(req, 'delete', 'company', id, row, null, '公司 #' + id + ' ' + (row.name || ''));
            res.json({ success: true, message: '公司已刪除' });
        });
    });
});

module.exports = router;
