const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { writeOperationLog } = require('../utils/operationLog');
const { updateBankAccountBalance } = require('../utils/bankAccountBalance');

// 確保上傳目錄存在
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        if (allowed.includes(file.mimetype) ||
            file.originalname.match(/\.(xlsx|xls)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('只允許上傳 Excel 檔案 (.xlsx / .xls)'));
        }
    }
});

// 取得所有收支記錄
router.get('/', (req, res) => {
    const { startDate, endDate, type, company, account, limit = 1000, offset = 0 } = req.query;

    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' ORDER BY transaction_date DESC, id DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows, count: rows.length });
    });
});

// 下載匯入範本 Excel（必須在 /:id 之前）
router.get('/template', async (req, res) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('收支記錄範本');

        worksheet.columns = [
            { header: '日期', key: 'date', width: 15 },
            { header: '說明', key: 'description', width: 40 },
            { header: '類型', key: 'type', width: 10 },
            { header: '金額', key: 'amount', width: 15 },
            { header: '類別', key: 'category', width: 20 },
            { header: '公司名稱', key: 'company', width: 25 },
            { header: '帳戶名稱', key: 'account', width: 25 },
            { header: '帳號', key: 'accountNumber', width: 20 },
            { header: '備註', key: 'remarks', width: 30 }
        ];

        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

        const noteRow = worksheet.addRow([]);
        worksheet.mergeCells('A2:I2');
        noteRow.getCell(1).value = '說明：日期支援民國年格式（如：115/01/01）或西元年格式（如：2026/01/01）。金額可用括號表示負數（表示支出）。類型欄位可填「收入」或「支出」，如不填寫，系統會根據金額正負自動判斷。';
        noteRow.getCell(1).font = { size: 10, color: { argb: 'FF666666' }, italic: true };
        noteRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
        noteRow.height = 40;

        const today = new Date();
        const rocYear = today.getFullYear() - 1911;
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        const exampleDate = `${rocYear}/${month}/${day}`;

        const row1 = worksheet.addRow({
            date: exampleDate,
            description: '範例：薪資收入',
            type: '收入',
            amount: 50000,
            category: '薪資',
            company: '範例公司',
            account: '台灣銀行',
            accountNumber: '1234567890',
            remarks: '這是收入範例'
        });

        const row2 = worksheet.addRow({
            date: exampleDate,
            description: '範例：辦公室租金',
            type: '支出',
            amount: 30000,
            category: '租金',
            company: '範例公司',
            account: '台灣銀行',
            accountNumber: '1234567890',
            remarks: '這是支出範例'
        });

        row1.getCell('amount').numFmt = '#,##0';
        row2.getCell('amount').numFmt = '#,##0_);(#,##0)';
        row2.getCell('amount').value = -30000;
        row2.getCell('amount').font = { color: { argb: 'FFFF0000' } };

        row1.getCell('date').alignment = { horizontal: 'center' };
        row2.getCell('date').alignment = { horizontal: 'center' };

        const fileName = `收支記錄匯入範本.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        logger.error('生成範本錯誤:', error);
        res.status(500).json({ error: '生成範本失敗', details: error.message });
    }
});

// 匯出收支記錄為 Excel（必須在 /:id 之前）
router.get('/export', (req, res) => {
    const { startDate, endDate, type, company, account } = req.query;

    let query = 'SELECT * FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' ORDER BY transaction_date ASC, id ASC';

    db.all(query, params, async (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }

        try {
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('收支記錄');

            worksheet.columns = [
                { header: '日期', key: 'date', width: 12 },
                { header: '說明', key: 'description', width: 50 },
                { header: '金額', key: 'amount', width: 15 },
                { header: '類型', key: 'type', width: 10 },
                { header: '類別', key: 'category', width: 20 },
                { header: '公司名稱', key: 'company', width: 25 },
                { header: '帳戶名稱', key: 'account', width: 25 },
                { header: '帳號', key: 'accountNumber', width: 20 },
                { header: '備註', key: 'remarks', width: 30 }
            ];

            const headerRow = worksheet.getRow(1);
            headerRow.font = { bold: true };
            headerRow.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFE0E0E0' }
            };
            headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

            function toROCYear(dateStr) {
                if (!dateStr) return '';
                const date = new Date(dateStr);
                const year = date.getFullYear();
                const rocYear = year - 1911;
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${rocYear}/${month}/${day}`;
            }

            rows.forEach((row) => {
                const dataRow = worksheet.addRow({
                    date: toROCYear(row.transaction_date),
                    description: row.description || '',
                    amount: row.type === 'expense' ? -Math.abs(row.amount) : (row.type === 'income' ? Math.abs(row.amount) : ''),
                    type: row.type === 'income' ? '收入' : '支出',
                    category: row.category || '',
                    company: row.company_name || '',
                    account: row.account_name || '',
                    accountNumber: row.account_number || '',
                    remarks: row.remarks || ''
                });

                const amountCell = dataRow.getCell('amount');
                if (amountCell.value !== '') {
                    if (row.type === 'expense') {
                        amountCell.numFmt = '#,##0_);(#,##0)';
                        amountCell.font = { color: { argb: 'FFFF0000' } };
                    } else {
                        amountCell.numFmt = '#,##0';
                    }
                }

                dataRow.getCell('date').alignment = { horizontal: 'center' };
            });

            const fileName = `收支記錄_${new Date().toISOString().split('T')[0]}.xlsx`;

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

            await workbook.xlsx.write(res);
            res.end();
        } catch (error) {
            logger.error('匯出錯誤:', error);
            res.status(500).json({ error: '匯出失敗', details: error.message });
        }
    });
});

// 取得收支統計（必須在 /:id 之前）
router.get('/statistics', (req, res) => {
    const { startDate, endDate, company, account } = req.query;

    let query = 'SELECT type, SUM(amount) as total_amount FROM transactions WHERE 1=1';
    const params = [];

    if (startDate) {
        query += ' AND transaction_date >= ?';
        params.push(startDate);
    }
    if (endDate) {
        query += ' AND transaction_date <= ?';
        params.push(endDate);
    }
    if (company) {
        query += ' AND company_name LIKE ?';
        params.push(`%${company}%`);
    }
    if (account) {
        query += ' AND (account_name LIKE ? OR account_number LIKE ?)';
        params.push(`%${account}%`, `%${account}%`);
    }

    query += ' GROUP BY type';

    db.all(query, params, (err, rows) => {
        if (err) {
            logger.error('查詢錯誤:', err);
            return res.status(500).json({ error: '查詢失敗', details: err.message });
        }
        res.json({ data: rows });
    });
});

// 批次刪除收支記錄（必須在 /:id 之前）
router.post('/batch-delete', async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: '請提供要刪除的記錄 id 陣列 (ids)' });
    }
    const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    if (numericIds.length === 0) {
        return res.status(400).json({ error: 'ids 格式錯誤' });
    }
    let deletedCount = 0;
    const placeholders = numericIds.map(() => '?').join(',');
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT * FROM transactions WHERE id IN (${placeholders})`,
                numericIds,
                (err, r) => (err ? reject(err) : resolve(r || []))
            );
        });
        for (const row of rows) {
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM transactions WHERE id = ?', [row.id], function(err) {
                    if (err) return reject(err);
                    deletedCount += this.changes;
                    if (this.changes > 0) {
                        writeOperationLog(req, 'delete', 'transaction', row.id, row, null, '收支記錄 #' + row.id);
                    }
                    resolve();
                });
            });
            try {
                if (row.account_name) {
                    await updateBankAccountBalance(row.account_name, row.account_number, row.company_name || null);
                }
            } catch (e) {
                logger.error('更新帳戶餘額失敗:', e);
            }
        }
        res.json({ success: true, message: `已刪除 ${deletedCount} 筆記錄`, deletedCount });
    } catch (err) {
        logger.error('批次刪除錯誤:', err);
        res.status(500).json({ error: '批次刪除失敗', details: err.message });
    }
});

// 匯入收支記錄 Excel（必須在 /:id 之前）
router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '請選擇要匯入的檔案' });
    }

    const filePath = req.file.path;
    const errors = [];
    let importedCount = 0;
    let skippedCount = 0;

    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        const worksheet = workbook.worksheets[0];

        function getCellText(value) {
            if (value === null || value === undefined) return '';
            if (typeof value === 'object') {
                if (Array.isArray(value.richText)) {
                    return value.richText.map(t => (t && t.text) ? t.text : '').join('').trim();
                }
                if (typeof value.text === 'string') return value.text.trim();
                if (value.result !== undefined && value.result !== null) return getCellText(value.result);
            }
            return String(value).trim();
        }

        const headerRow = worksheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            headers[colNumber - 1] = getCellText(cell.value);
        });

        function fromROCYear(rocDateStr) {
            if (!rocDateStr) return null;
            const str = String(rocDateStr).trim();
            const match = str.match(/(\d{3})\/(\d{1,2})\/(\d{1,2})/) || str.match(/(\d{3})(\d{2})(\d{2})/) || str.match(/(\d{3})(\d{1,2})(\d{1,2})/);
            if (match) {
                const rocYear = parseInt(match[1], 10);
                const month = String(parseInt(match[2], 10)).padStart(2, '0');
                const day = String(parseInt(match[3], 10)).padStart(2, '0');
                if (parseInt(month, 10) > 12 || parseInt(month, 10) < 1 || parseInt(day, 10) < 1 || parseInt(day, 10) > 31) return null;
                const year = rocYear + 1911;
                return `${year}-${month}-${day}`;
            }
            return null;
        }

        function parseAmount(value) {
            if (value === null || value === undefined || value === '') return null;
            const str = getCellText(value);
            let amount = parseFloat(str.replace(/,/g, '').replace(/[()]/g, ''));
            if (isNaN(amount)) return null;
            if (str.includes('(') || amount < 0) {
                return Math.abs(amount);
            }
            return amount;
        }

        function findColumnIndex(keywords) {
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i] || '').toLowerCase();
                for (const keyword of keywords) {
                    if (header.includes(keyword.toLowerCase())) {
                        return i;
                    }
                }
            }
            return -1;
        }

        const dateIndex = findColumnIndex(['日期', 'date', '交易日期']);
        const descIndex = findColumnIndex(['說明', '描述', 'description', 'desc', '摘要']);
        const typeIndex = findColumnIndex(['類型', 'type', '收支類型']);
        const categoryIndex = findColumnIndex(['類別', 'category']);
        const companyIndex = findColumnIndex(['公司', 'company', '公司名稱']);
        const accountIndex = findColumnIndex(['帳戶', 'account', '帳戶名稱']);
        const accountNumIndex = findColumnIndex(['帳號', 'account_number', 'accountnumber']);
        const remarksIndex = findColumnIndex(['備註', 'remarks', 'note', 'notes']);

        const amountIndices = [];
        for (let i = 0; i < headers.length; i++) {
            const header = String(headers[i] || '').toLowerCase();
            if (header.includes('金額') || header.includes('amount') || header.match(/^金額\d+$/)) {
                amountIndices.push(i);
            }
        }

        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);

            let isEmpty = true;
            row.eachCell({ includeEmpty: false }, () => {
                isEmpty = false;
            });
            if (isEmpty) continue;

            try {
                let transactionDate = null;
                if (dateIndex >= 0) {
                    const dateCell = row.getCell(dateIndex + 1);
                    let dateValue = dateCell.value;
                    if (dateValue instanceof Date) {
                        transactionDate = dateValue.toISOString().split('T')[0];
                    } else if (dateValue) {
                        transactionDate = fromROCYear(String(dateValue));
                    }
                }

                if (!transactionDate) {
                    skippedCount++;
                    continue;
                }

                let description = '';
                if (descIndex >= 0) {
                    const descCell = row.getCell(descIndex + 1);
                    description = getCellText(descCell.value);
                }

                let type = 'expense';
                if (typeIndex >= 0) {
                    const typeCell = row.getCell(typeIndex + 1);
                    const typeValue = getCellText(typeCell.value);
                    if (typeValue.includes('收入') || typeValue.toLowerCase().includes('income')) {
                        type = 'income';
                    }
                } else {
                    let hasNegativeAmount = false;
                    for (const amtIdx of amountIndices) {
                        const amtCell = row.getCell(amtIdx + 1);
                        const amtValue = amtCell.value;
                        if (amtValue && (String(amtValue).includes('(') || parseFloat(String(amtValue).replace(/,/g, '')) < 0)) {
                            hasNegativeAmount = true;
                            break;
                        }
                    }
                    type = hasNegativeAmount ? 'expense' : 'income';
                }

                let amount = null;
                for (const amtIdx of amountIndices) {
                    const amtCell = row.getCell(amtIdx + 1);
                    const amtValue = parseAmount(amtCell.value);
                    if (amtValue !== null && amtValue !== 0) {
                        amount = amtValue;
                        break;
                    }
                }

                if (!amount || amount === 0) {
                    skippedCount++;
                    continue;
                }

                const category = categoryIndex >= 0 ? getCellText(row.getCell(categoryIndex + 1).value) : '';
                const companyName = companyIndex >= 0 ? getCellText(row.getCell(companyIndex + 1).value) : '';
                const accountName = accountIndex >= 0 ? getCellText(row.getCell(accountIndex + 1).value) : '';
                const accountNumber = accountNumIndex >= 0 ? getCellText(row.getCell(accountNumIndex + 1).value) : '';
                const remarks = remarksIndex >= 0 ? getCellText(row.getCell(remarksIndex + 1).value) : '';

                await new Promise((resolve, reject) => {
                    db.run(
                        `INSERT INTO transactions 
                         (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [transactionDate, type, amount, category || null, description || null,
                         companyName || null, accountName || null, accountNumber || null, remarks || null],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        }
                    );
                });

                importedCount++;
            } catch (rowError) {
                errors.push(`第 ${rowNumber} 行: ${rowError.message}`);
            }
        }

        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: `匯入完成：成功 ${importedCount} 筆，跳過 ${skippedCount} 筆`,
            importedCount,
            skippedCount,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        logger.error('匯入錯誤:', error);
        res.status(500).json({ error: '匯入失敗', details: error.message });
    }
});

// 取得單一收支記錄
router.get('/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, row) => {
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

// 新增收支記錄
router.post('/', (req, res) => {
    const {
        transaction_date,
        type,
        amount,
        category,
        description,
        company_name,
        account_name,
        account_number,
        remarks
    } = req.body;

    if (!transaction_date || !type || amount === undefined) {
        return res.status(400).json({ error: 'transaction_date、type 和 amount 為必填欄位' });
    }

    if (type !== 'income' && type !== 'expense') {
        return res.status(400).json({ error: 'type 必須是 income 或 expense' });
    }

    db.run(
        `INSERT INTO transactions 
         (transaction_date, type, amount, category, description, company_name, account_name, account_number, remarks) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [transaction_date, type, amount, category || null, description || null,
         company_name || null, account_name || null, account_number || null, remarks || null],
        async function(err) {
            if (err) {
                logger.error('新增錯誤:', err);
                return res.status(500).json({ error: '新增失敗', details: err.message });
            }

            const newId = this.lastID;
            const afterData = { id: newId, transaction_date, type, amount, category: category || null, description: description || null, company_name: company_name || null, account_name: account_name || null, account_number: account_number || null, remarks: remarks || null };
            writeOperationLog(req, 'create', 'transaction', newId, null, afterData, '收支記錄 #' + newId);
            try {
                if (account_name) {
                    await updateBankAccountBalance(account_name, account_number, company_name || null);
                }
            } catch (error) {
                logger.error('更新帳戶餘額失敗:', error);
            }
            res.json({ success: true, id: newId, message: '記錄已新增' });
        }
    );
});

// 更新收支記錄
router.put('/:id', (req, res) => {
    const { id } = req.params;
    const {
        transaction_date,
        type,
        amount,
        category,
        description,
        company_name,
        account_name,
        account_number,
        remarks
    } = req.body;

    if (type && type !== 'income' && type !== 'expense') {
        return res.status(400).json({ error: 'type 必須是 income 或 expense' });
    }

    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, oldRow) => {
        if (err) {
            logger.error('查詢舊記錄錯誤:', err);
            return res.status(500).json({ error: '更新失敗', details: err.message });
        }
        if (!oldRow) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const oldTransaction = oldRow;
        const afterData = { id: parseInt(id, 10), transaction_date, type, amount, category: category || null, description: description || null, company_name: company_name || null, account_name: account_name || null, account_number: account_number || null, remarks: remarks || null };
        db.run(
            `UPDATE transactions 
             SET transaction_date = ?, type = ?, amount = ?, category = ?, description = ?,
                 company_name = ?, account_name = ?, account_number = ?, remarks = ?, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [transaction_date, type, amount, category || null, description || null,
             company_name || null, account_name || null, account_number || null, remarks || null, id],
            async function(err) {
                if (err) {
                    logger.error('更新錯誤:', err);
                    return res.status(500).json({ error: '更新失敗', details: err.message });
                }
                if (this.changes === 0) {
                    return res.status(404).json({ error: '找不到記錄' });
                }
                writeOperationLog(req, 'update', 'transaction', id, oldRow, afterData, '收支記錄 #' + id);
                try {
                    const accountChanged = oldTransaction.account_name !== account_name || oldTransaction.account_number !== account_number;
                    if (accountChanged && oldTransaction.account_name) {
                        await updateBankAccountBalance(oldTransaction.account_name, oldTransaction.account_number, oldTransaction.company_name || null);
                    }
                    if (account_name) {
                        await updateBankAccountBalance(account_name, account_number, company_name || null);
                    }
                } catch (error) {
                    logger.error('更新帳戶餘額失敗:', error);
                }
                res.json({ success: true, message: '記錄已更新' });
            }
        );
    });
});

// 刪除收支記錄
router.delete('/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT * FROM transactions WHERE id = ?', [id], (err, row) => {
        if (err) {
            logger.error('查詢記錄錯誤:', err);
            return res.status(500).json({ error: '刪除失敗', details: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: '找不到記錄' });
        }
        const transaction = row;
        db.run('DELETE FROM transactions WHERE id = ?', [id], async function(err) {
            if (err) {
                logger.error('刪除錯誤:', err);
                return res.status(500).json({ error: '刪除失敗', details: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '找不到記錄' });
            }
            writeOperationLog(req, 'delete', 'transaction', id, transaction, null, '收支記錄 #' + id);
            try {
                if (transaction.account_name) {
                    await updateBankAccountBalance(transaction.account_name, transaction.account_number, transaction.company_name || null);
                }
            } catch (error) {
                logger.error('更新帳戶餘額失敗:', error);
            }
            res.json({ success: true, message: '記錄已刪除' });
        });
    });
});

module.exports = router;
