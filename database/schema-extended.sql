-- 資金週報系統 - 完整版資料庫結構

-- 1. 銀行帳戶主檔
CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_name TEXT NOT NULL,              -- 帳戶名稱
    account_number TEXT,                     -- 帳號
    bank_name TEXT,                          -- 銀行名稱
    currency TEXT DEFAULT 'TWD',             -- 幣別
    initial_balance DECIMAL(15, 2) DEFAULT 0, -- 期初餘額
    company_name TEXT,                       -- 所屬公司
    is_active INTEGER DEFAULT 1,             -- 是否啟用
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 資金流入記錄（收入）
CREATE TABLE IF NOT EXISTS cash_inflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,               -- 報告日期
    bank_account_id INTEGER,                 -- 銀行帳戶ID
    category TEXT NOT NULL,                  -- 類別：AR收款、利息收入、資產處分、銀行撥款等
    amount DECIMAL(15, 2) NOT NULL,          -- 金額
    currency TEXT DEFAULT 'TWD',             -- 幣別
    exchange_rate DECIMAL(10, 4) DEFAULT 1,  -- 匯率（相對於本位幣）
    amount_base_currency DECIMAL(15, 2),     -- 本位幣金額
    description TEXT,                        -- 說明
    reference_number TEXT,                   -- 參考單號
    is_actual INTEGER DEFAULT 0,             -- 0=預測, 1=實績
    forecast_week INTEGER,                   -- 預測週數（未來第幾週）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id)
);

-- 3. 資金流出記錄（支出）
CREATE TABLE IF NOT EXISTS cash_outflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,               -- 報告日期
    bank_account_id INTEGER,                 -- 銀行帳戶ID
    category TEXT NOT NULL,                  -- 類別：AP付款、薪資、稅金、資本支出、還本付息等
    amount DECIMAL(15, 2) NOT NULL,          -- 金額
    currency TEXT DEFAULT 'TWD',             -- 幣別
    exchange_rate DECIMAL(10, 4) DEFAULT 1,  -- 匯率
    amount_base_currency DECIMAL(15, 2),     -- 本位幣金額
    description TEXT,                        -- 說明
    reference_number TEXT,                   -- 參考單號
    is_actual INTEGER DEFAULT 0,             -- 0=預測, 1=實績
    forecast_week INTEGER,                   -- 預測週數
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id)
);

-- 4. 資金預測（週報主檔）
CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,               -- 報告日期（週報日期）
    week_number INTEGER,                     -- 週次
    bank_account_id INTEGER,                 -- 銀行帳戶ID
    opening_balance DECIMAL(15, 2) DEFAULT 0, -- 期初餘額
    total_inflow DECIMAL(15, 2) DEFAULT 0,   -- 總流入
    total_outflow DECIMAL(15, 2) DEFAULT 0,  -- 總流出
    closing_balance DECIMAL(15, 2) DEFAULT 0, -- 期末餘額
    safety_level DECIMAL(15, 2),             -- 安全水位
    is_above_safety INTEGER DEFAULT 1,       -- 是否高於安全水位
    notes TEXT,                              -- 備註
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id),
    UNIQUE(report_date, bank_account_id)
);

-- 5. 差異分析記錄
CREATE TABLE IF NOT EXISTS variance_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date DATE NOT NULL,               -- 報告日期
    bank_account_id INTEGER,                 -- 銀行帳戶ID
    category TEXT NOT NULL,                  -- 類別：inflow/outflow
    forecast_amount DECIMAL(15, 2),          -- 預測金額
    actual_amount DECIMAL(15, 2),            -- 實績金額
    variance DECIMAL(15, 2),                 -- 差異金額
    variance_percentage DECIMAL(5, 2),       -- 差異百分比
    reason TEXT,                             -- 差異原因
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id)
);

-- 6. 融資額度與借貸記錄
CREATE TABLE IF NOT EXISTS financing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER,                 -- 銀行帳戶ID
    facility_type TEXT NOT NULL,             -- 額度類型：授信額度、短期借款、長期借款等
    total_limit DECIMAL(15, 2),              -- 總額度
    used_amount DECIMAL(15, 2) DEFAULT 0,    -- 已使用額度
    available_amount DECIMAL(15, 2),         -- 可用額度
    interest_rate DECIMAL(5, 2),             -- 利率
    maturity_date DATE,                      -- 到期日
    next_payment_date DATE,                  -- 下次還款日
    next_payment_amount DECIMAL(15, 2),      -- 下次還款金額
    notes TEXT,                              -- 備註
    is_active INTEGER DEFAULT 1,             -- 是否啟用
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id)
);

-- 7. 匯率記錄
CREATE TABLE IF NOT EXISTS exchange_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    currency TEXT NOT NULL,                  -- 幣別
    rate DECIMAL(10, 4) NOT NULL,            -- 匯率（相對於本位幣）
    rate_date DATE NOT NULL,                 -- 匯率日期
    source TEXT,                             -- 匯率來源
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(currency, rate_date)
);

-- 8. 匯入記錄（保留原有功能）
CREATE TABLE IF NOT EXISTS import_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    record_count INTEGER,
    status TEXT
);

-- 建立索引
CREATE INDEX IF NOT EXISTS idx_weekly_reports_date ON weekly_reports(report_date);
CREATE INDEX IF NOT EXISTS idx_weekly_reports_account ON weekly_reports(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_inflows_date ON cash_inflows(report_date);
CREATE INDEX IF NOT EXISTS idx_inflows_account ON cash_inflows(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_outflows_date ON cash_outflows(report_date);
CREATE INDEX IF NOT EXISTS idx_outflows_account ON cash_outflows(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_variance_date ON variance_analysis(report_date);
CREATE INDEX IF NOT EXISTS idx_exchange_rates_date ON exchange_rates(rate_date);

