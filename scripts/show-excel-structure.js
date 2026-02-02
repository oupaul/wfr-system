const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// 取得 Excel 檔案路徑
const excelFilePath = process.argv[2] || path.join(__dirname, '..', 'B公司與A公司-資金週報1141227.xlsx');

async function showExcelStructure() {
    try {
        if (!fs.existsSync(excelFilePath)) {
            console.error(`錯誤：找不到檔案 ${excelFilePath}`);
            process.exit(1);
        }

        console.log('=========================================');
        console.log('  Excel 檔案結構分析');
        console.log('=========================================');
        console.log(`檔案路徑: ${excelFilePath}`);
        console.log('');

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(excelFilePath);
        
        // 顯示所有工作表
        console.log(`工作表數量: ${workbook.worksheets.length}`);
        console.log('工作表列表:');
        workbook.worksheets.forEach((sheet, index) => {
            console.log(`  ${index + 1}. ${sheet.name} (行數: ${sheet.rowCount}, 欄數: ${sheet.columnCount})`);
        });
        console.log('');

        // 分析第一個工作表
        const worksheet = workbook.worksheets[0];
        console.log(`正在分析工作表: ${worksheet.name}`);
        console.log('');

        // 讀取標題行（第一行）
        const headerRow = worksheet.getRow(1);
        const headers = [];
        
        console.log('標題行（第一行）欄位：');
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
            console.log(`  欄位 ${colNumber}: "${headerValue}"`);
        });
        console.log('');

        // 顯示前 10 行資料範例
        console.log('前 10 行資料範例：');
        console.log('');
        for (let rowNumber = 1; rowNumber <= Math.min(11, worksheet.rowCount); rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const rowData = {};
            
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                const header = headers[colNumber - 1];
                if (header) {
                    let value = cell.value;
                    if (value === null || value === undefined) {
                        value = '';
                    } else if (typeof value === 'object' && value.text !== undefined) {
                        value = value.text;
                    } else if (value instanceof Date) {
                        value = value.toISOString().split('T')[0];
                    } else {
                        value = String(value).trim();
                    }
                    rowData[header] = value;
                }
            });
            
            // 檢查是否為空行
            const hasData = Object.values(rowData).some(val => val !== '' && val !== null && val !== undefined);
            
            if (hasData || rowNumber === 1) {
                console.log(`第 ${rowNumber} 行:`);
                Object.entries(rowData).forEach(([key, value]) => {
                    const displayValue = value === '' ? '(空)' : value;
                    console.log(`  ${key}: ${displayValue}`);
                });
                console.log('');
            }
        }

        // 分析資料類型
        console.log('欄位分析建議：');
        console.log('');
        
        const fieldSuggestions = {
            date: ['日期', 'Date', 'date', '報告日期', '週報日期', '年月日'],
            company: ['公司', 'Company', 'company', '公司名稱', '公司名', '單位'],
            account: ['帳戶', 'Account', 'account', '帳戶名稱', '戶名', '銀行'],
            accountNumber: ['帳號', 'Account Number', 'account_number', '帳戶號碼', '銀行帳號'],
            balance: ['餘額', 'Balance', 'balance', '餘額(元)', '金額', 'Amount', '現金'],
            remarks: ['備註', 'Remarks', 'remarks', '備註說明', '說明', 'Note', 'notes', '摘要']
        };

        headers.forEach((header, index) => {
            const suggestions = [];
            Object.entries(fieldSuggestions).forEach(([fieldType, possibleNames]) => {
                if (possibleNames.some(name => header.includes(name) || name.includes(header))) {
                    suggestions.push(fieldType);
                }
            });
            
            if (suggestions.length > 0) {
                console.log(`  "${header}" -> 建議對應: ${suggestions.join(', ')}`);
            } else {
                console.log(`  "${header}" -> 未找到明確對應，請手動配置`);
            }
        });

        console.log('');
        console.log('=========================================');
        console.log('  分析完成');
        console.log('=========================================');
        console.log('');
        console.log('如果欄位名稱與系統預設不符，請修改 config/excel-mapping.js 檔案');
        console.log('');

    } catch (error) {
        console.error('讀取 Excel 結構時發生錯誤:', error);
        process.exit(1);
    }
}

showExcelStructure();

