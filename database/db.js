const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 確保 database 目錄存在
const dbDir = path.join(__dirname);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'fund_report.db');

// 建立資料庫連線
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('資料庫連線錯誤:', err.message);
    } else {
        console.log('已連線到 SQLite 資料庫');
    }
});

// 初始化資料庫表格
const initDatabase = () => {
    return new Promise(async (resolve, reject) => {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        db.exec(schema, async (err) => {
            if (err) {
                console.error('資料庫初始化錯誤:', err.message);
                reject(err);
            } else {
                console.log('資料庫表格已建立');
                try {
                    // 確保新表結構也已建立（支援現有資料庫升級）
                    await ensureNewTables();
                    // 執行資料庫遷移
                    await migrateBankAccountsCurrentBalance();
                    await ensureOperationLogsTable();
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }
        });
    });
};

// 確保新表結構存在（用於資料庫升級）
const ensureNewTables = () => {
    return new Promise((resolve, reject) => {
        const migrationSQL = `
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(transaction_date);
            CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
            CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_name);
            
            -- 餘額結算記錄表（注意：UNIQUE約束在schema.sql中定義，這裡僅創建表結構）
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
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
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
                current_balance DECIMAL(15, 2) DEFAULT 0,
                remarks TEXT,
                is_active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
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
                role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user')),
                is_active INTEGER DEFAULT 1,
                last_login DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            
            CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
            CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
            CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

            -- 系統設定（key-value），目前用於 M365 / Entra ID SSO 設定
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `;
        
        db.exec(migrationSQL, (err) => {
            if (err) {
                console.error('資料庫升級錯誤:', err.message);
                reject(err);
            } else {
                // 檢查並添加 safety_level 欄位（如果不存在）
                db.all("PRAGMA table_info(bank_accounts)", [], (err, columns) => {
                    if (!err && columns) {
                        const hasSafetyLevel = columns.some(col => col.name === 'safety_level');
                        if (!hasSafetyLevel) {
                            db.run("ALTER TABLE bank_accounts ADD COLUMN safety_level DECIMAL(15, 2) DEFAULT 0", (alterErr) => {
                                if (alterErr) {
                                    // 欄位可能已存在，忽略錯誤
                                    if (!alterErr.message.includes('duplicate column')) {
                                        console.error('添加safety_level欄位錯誤:', alterErr.message);
                                    }
                                } else {
                                    console.log('已添加safety_level欄位到bank_accounts表');
                                }
                                console.log('資料庫升級完成（新表結構已確保）');
                                resolve();
                            });
                        } else {
                            console.log('資料庫升級完成（新表結構已確保）');
                            resolve();
                        }
                    } else {
                        console.log('資料庫升級完成（新表結構已確保）');
                        resolve();
                    }
                });
            }
        });
    });
};

// 確保操作日誌表存在（不加 FOREIGN KEY 避免 user_id 參考導致 INSERT 失敗）
const ensureOperationLogsTable = () => {
    return new Promise((resolve, reject) => {
        const sql = `
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
        `;
        db.exec(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
};

// 資料庫遷移：為 bank_accounts 表添加 current_balance 欄位
const migrateBankAccountsCurrentBalance = () => {
    return new Promise((resolve, reject) => {
        // 檢查 current_balance 欄位是否存在
        db.all("PRAGMA table_info(bank_accounts)", [], (err, columns) => {
            if (err) {
                console.error('檢查 bank_accounts 表結構失敗:', err);
                return reject(err);
            }
            
            const hasCurrentBalance = columns.some(col => col.name === 'current_balance');
            
            if (!hasCurrentBalance) {
                console.log('正在為 bank_accounts 表添加 current_balance 欄位...');
                db.run(
                    'ALTER TABLE bank_accounts ADD COLUMN current_balance DECIMAL(15, 2) DEFAULT 0',
                    (err) => {
                        if (err) {
                            console.error('添加 current_balance 欄位失敗:', err);
                            return reject(err);
                        }
                        console.log('✓ current_balance 欄位已添加');
                        resolve();
                    }
                );
            } else {
                resolve();
            }
        });
    });
};

// 關閉資料庫連線
const closeDatabase = () => {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) {
                reject(err);
            } else {
                console.log('資料庫連線已關閉');
                resolve();
            }
        });
    });
};

module.exports = {
    db,
    initDatabase,
    closeDatabase,
    migrateBankAccountsCurrentBalance,
    ensureOperationLogsTable
};
