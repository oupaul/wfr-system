// Excel 欄位對應設定
// 根據您的 Excel 檔案欄位名稱，調整以下對應關係

module.exports = {
    // 日期欄位（支援多種名稱）
    date: ['日期', 'Date', 'date', 'report_date', '報告日期', '週報日期'],
    
    // 公司名稱欄位
    company: ['公司名稱', 'Company', 'company', 'company_name', '公司', '公司名'],
    
    // 帳戶名稱欄位
    accountName: ['帳戶名稱', 'Account', 'account', 'account_name', '帳戶', '戶名'],
    
    // 帳號欄位
    accountNumber: ['帳號', 'Account Number', 'account_number', '帳戶號碼', 'AccountNumber'],
    
    // 餘額欄位
    balance: ['餘額', 'Balance', 'balance', '餘額(元)', '金額', 'Amount'],
    
    // 備註欄位
    remarks: ['備註', 'Remarks', 'remarks', '備註說明', '說明', 'Note', 'notes']
};

// 使用範例：
// 如果您的 Excel 欄位名稱是 "日期", "公司", "餘額" 等，系統會自動識別
// 如果欄位名稱不同，請在對應陣列中加入您的欄位名稱
