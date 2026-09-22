-- 資金週報系統資料庫結構

-- 主要資料表：資金週報記錄
CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,
    company_name TEXT NOT NULL,
    account_name TEXT,
    account_number TEXT,
    balance DECIMAL(15, 2),
    remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 建立索引以加速查詢
CREATE INDEX IF NOT EXISTS idx_report_date ON weekly_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_company_name ON weekly_reports(company_name);

-- 匯入記錄表（記錄匯入歷史）
CREATE TABLE IF NOT EXISTS import_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    record_count INTEGER,
    status TEXT
);

-- 日常收支記錄表
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_date DATE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    amount DECIMAL(15, 2) NOT NULL,
    category TEXT,
    description TEXT,
    company_name TEXT,
    account_name TEXT,
    account_number TEXT,
    remarks TEXT,
    transfer_group_id TEXT DEFAULT NULL,  -- 帳戶間轉帳：同一次轉帳的兩筆記錄共用同一個 id，一般收支記錄為 NULL
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 建立索引
-- 注意：idx_transactions_transfer_group 不能加在這裡。這個 CREATE TABLE IF NOT
-- EXISTS 對「已經存在的 transactions 表」（也就是所有既有安裝）是 no-op，不會
-- 補上 transfer_group_id 欄位；若在這裡對這個欄位建索引，既有資料庫每次啟動都
-- 會直接噴 SQLITE_ERROR: no such column。這個索引改成只在
-- database/db.js 的 migrateTransactionsTransferGroup() 裡、確認欄位存在之後才建立。
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_name);

-- 餘額結算記錄表
CREATE TABLE IF NOT EXISTS balance_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_date DATE NOT NULL,
    company_name TEXT NOT NULL,
    account_name TEXT,
    account_number TEXT,
    previous_settlement_date DATE,
    opening_balance DECIMAL(15, 2) DEFAULT 0,
    total_income DECIMAL(15, 2) DEFAULT 0,
    total_expense DECIMAL(15, 2) DEFAULT 0,
    calculated_balance DECIMAL(15, 2) DEFAULT 0,
    actual_balance DECIMAL(15, 2) NOT NULL,
    difference DECIMAL(15, 2) DEFAULT 0,
    remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(settlement_date, company_name, account_name, account_number)
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_settlements_date ON balance_settlements(settlement_date);
CREATE INDEX IF NOT EXISTS idx_settlements_company ON balance_settlements(company_name);

-- 公司資訊表
CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    code TEXT,
    contact_person TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    address TEXT,
    remarks TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(is_active);

-- 銀行帳戶資訊表
CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    account_name TEXT NOT NULL,
    account_number TEXT,
    bank_name TEXT,
    branch_name TEXT,
    account_type TEXT,
    currency TEXT DEFAULT 'TWD',
    safety_level DECIMAL(15, 2) DEFAULT 0,
    current_balance DECIMAL(15, 2) DEFAULT 0,  -- 即時餘額（根據交易記錄自動更新）
    remarks TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_bank_accounts_company ON bank_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_active ON bank_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_name ON bank_accounts(account_name);

-- 用戶表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    email TEXT,
    role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'finance', 'user')),
    is_active INTEGER DEFAULT 1,
    last_login DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 操作日誌表（記錄新增/修改/刪除前後差異，不加 FOREIGN KEY 避免 user_id 參考導致寫入失敗）
CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete')),
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    before_data TEXT,
    after_data TEXT,
    summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_entity ON operation_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_operation_logs_user ON operation_logs(user_id);

-- 系統設定（key-value），目前用於 M365 / Entra ID SSO 設定，讓管理者可在後台調整而不用改 .env
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 借款/融資額度主檔
CREATE TABLE IF NOT EXISTS financing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    bank_account_id INTEGER,              -- 撥款/還款帳戶（選填）
    facility_name TEXT NOT NULL,          -- 借款/額度名稱
    facility_type TEXT NOT NULL DEFAULT '短期借款'
        CHECK(facility_type IN ('授信額度', '短期借款', '長期借款', '其他')),
    lender TEXT,                          -- 貸款機構
    total_limit DECIMAL(15, 2),           -- 總額度（授信額度類型適用，選填）
    principal_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,  -- 原始本金/動用金額
    interest_rate DECIMAL(6, 3),          -- 年利率 (%)
    start_date DATE,
    maturity_date DATE,
    repayment_method TEXT,                -- 還款方式說明文字
    next_payment_date DATE,
    next_payment_amount DECIMAL(15, 2),
    repayment_frequency TEXT DEFAULT NULL
        CHECK(repayment_frequency IN ('monthly', 'quarterly') OR repayment_frequency IS NULL),
        -- 還款頻率：NULL=不重複（只投影 next_payment_date 這一筆）、monthly=每月、
        -- quarterly=每季。有設定時，資金流水帳/資金缺口會從 next_payment_date 開始
        -- 以同樣的 next_payment_amount 自動往後投影到 maturity_date 或預測窗口結束
    remarks TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_financing_company ON financing(company_id);
CREATE INDEX IF NOT EXISTS idx_financing_active ON financing(is_active);

-- 還款記錄：目前本金餘額 = principal_amount - SUM(principal_paid)，即時計算不存欄位
CREATE TABLE IF NOT EXISTS financing_repayments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    financing_id INTEGER NOT NULL,
    payment_date DATE NOT NULL,
    principal_paid DECIMAL(15, 2) NOT NULL DEFAULT 0,
    interest_paid DECIMAL(15, 2) NOT NULL DEFAULT 0,
    remarks TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (financing_id) REFERENCES financing(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_financing_repayments_financing ON financing_repayments(financing_id);
