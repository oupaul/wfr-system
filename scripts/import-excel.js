const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { db, initDatabase, closeDatabase } = require('../database/db');
const fieldMapping = require('../config/excel-mapping');

// 取得 Excel 檔案路徑（從命令列參數或預設值，請依實際檔名調整或直接以參數指定）
const excelFilePath = process.argv[2] || path.join(__dirname, '..', 'import.xlsx');

// 從欄位對應配置中尋找對應的值
function findFieldValue(row, fieldNames) {
    for (const fieldName of fieldNames) {
        if (row[fieldName] !== undefined && row[fieldName] !== null && row[fieldName] !== '') {
            return row[fieldName];
        }
    }
    return null;
}

// 將 Excel 行轉換為物件
function rowToObject(row, headers) {
    const obj = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const header = headers[colNumber - 1];
        if (header) {
            // 處理不同的資料類型
            let value = cell.value;
            if (value === null || value === undefined) {
                value = '';
            } else if (typeof value === 'object' && value.text !== undefined) {
                // 處理富文本格式
                value = value.text;
            } else if (value instanceof Date) {
                // 處理日期格式
                value = value.toISOString().split('T')[0];
            } else {
                value = String(value).trim();
            }
            obj[header] = value;
        }
    });
    return obj;
}

async function importExcel() {
    try {
        // 檢查檔案是否存在
        if (!fs.existsSync(excelFilePath)) {
            console.error(`錯誤：找不到檔案 ${excelFilePath}`);
            process.exit(1);
        }

        console.log(`開始讀取 Excel 檔案: ${excelFilePath}`);
        
        // 初始化資料庫
        await initDatabase();

        // 建立 ExcelJS 工作簿
        const workbook = new ExcelJS.Workbook();
        
        // 讀取 Excel 檔案
        await workbook.xlsx.readFile(excelFilePath);
        
        // 取得第一個工作表
        const worksheet = workbook.worksheets[0];
        const sheetName = worksheet.name;
        
        console.log(`工作表名稱: ${sheetName}`);
        console.log(`總行數: ${worksheet.rowCount}`);

        // 讀取標題行（假設第一行是標題）
        const headerRow = worksheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            let headerValue = cell.value;
            if (headerValue === null || headerValue === undefined) {
                headerValue = '';
            } else if (typeof headerValue === 'object' && headerValue.text !== undefined) {
                headerValue = headerValue.text;
            } else {
                headerValue = String(headerValue).trim();
            }
            headers[colNumber - 1] = headerValue;
        });

        console.log('欄位名稱:', headers.join(', '));

        // 解析並匯入資料（從第二行開始）
        let importedCount = 0;
        const errors = [];

        for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            
            // 檢查是否為空行
            let isEmpty = true;
            row.eachCell({ includeEmpty: false }, () => {
                isEmpty = false;
            });
            if (isEmpty) {
                continue;
            }

            try {
                // 將行轉換為物件
                const rowData = rowToObject(row, headers);
                
                // 使用配置檔中的欄位對應來解析資料
                const reportDate = findFieldValue(rowData, fieldMapping.date);
                const companyName = findFieldValue(rowData, fieldMapping.company) || '';
                const accountName = findFieldValue(rowData, fieldMapping.accountName) || '';
                const accountNumber = findFieldValue(rowData, fieldMapping.accountNumber) || '';
                const balanceStr = findFieldValue(rowData, fieldMapping.balance) || '0';
                const balance = parseFloat(String(balanceStr).replace(/,/g, '')) || 0;
                const remarks = findFieldValue(rowData, fieldMapping.remarks) || '';

                // 跳過空白行
                if (!reportDate && !companyName) {
                    continue;
                }

                // 插入資料庫
                await new Promise((resolve, reject) => {
                    db.run(
                        `INSERT INTO weekly_reports 
                         (report_date, company_name, account_name, account_number, balance, remarks) 
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [reportDate, companyName, accountName, accountNumber, balance, remarks],
                        function(err) {
                            if (err) {
                                reject(err);
                            } else {
                                importedCount++;
                                resolve();
                            }
                        }
                    );
                });
            } catch (error) {
                errors.push({ row: rowNumber, error: error.message, data: 'N/A' });
            }
        }

        // 記錄匯入日誌
        const fileName = path.basename(excelFilePath);
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO import_logs (file_name, record_count, status) 
                 VALUES (?, ?, ?)`,
                [fileName, importedCount, errors.length > 0 ? '部分成功' : '成功'],
                (err) => {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        console.log(`\n匯入完成！`);
        console.log(`成功匯入: ${importedCount} 筆`);
        if (errors.length > 0) {
            console.log(`錯誤: ${errors.length} 筆`);
            errors.forEach(err => {
                console.log(`  第 ${err.row} 行: ${err.error}`);
            });
        }

        await closeDatabase();
        process.exit(0);
    } catch (error) {
        console.error('匯入過程發生錯誤:', error);
        await closeDatabase();
        process.exit(1);
    }
}

// 顯示 Excel 檔案結構（除錯用）
async function showExcelStructure() {
    try {
        if (!fs.existsSync(excelFilePath)) {
            console.error(`錯誤：找不到檔案 ${excelFilePath}`);
            return;
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(excelFilePath);
        
        const worksheet = workbook.worksheets[0];
        const sheetName = worksheet.name;
        
        console.log('Excel 檔案結構：');
        console.log('工作表名稱:', sheetName);
        console.log('總行數:', worksheet.rowCount);
        console.log('總欄數:', worksheet.columnCount);
        
        // 讀取標題行
        const headerRow = worksheet.getRow(1);
        const headers = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
            let headerValue = cell.value;
            if (headerValue === null || headerValue === undefined) {
                headerValue = '';
            } else if (typeof headerValue === 'object' && headerValue.text !== undefined) {
                headerValue = headerValue.text;
            } else {
                headerValue = String(headerValue).trim();
            }
            headers[colNumber - 1] = headerValue;
        });
        
        console.log('\n欄位名稱:');
        headers.forEach((header, index) => {
            console.log(`  ${index + 1}. ${header}`);
        });
        
        // 顯示前 5 行資料
        console.log('\n前 5 行資料:');
        for (let rowNumber = 2; rowNumber <= Math.min(6, worksheet.rowCount); rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const rowData = rowToObject(row, headers);
            
            let isEmpty = true;
            Object.values(rowData).forEach(val => {
                if (val !== '' && val !== null && val !== undefined) {
                    isEmpty = false;
                }
            });
            
            if (!isEmpty) {
                console.log(`\n第 ${rowNumber - 1} 行:`, JSON.stringify(rowData, null, 2));
            }
        }
    } catch (error) {
        console.error('讀取 Excel 結構時發生錯誤:', error);
    }
}

// 如果命令列有 --show-structure 參數，顯示結構
if (process.argv.includes('--show-structure')) {
    showExcelStructure().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    importExcel();
}