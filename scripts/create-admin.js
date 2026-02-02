/**
 * 創建管理員帳號腳本
 * 使用方法: node scripts/create-admin.js [username] [password]
 */

const argon2 = require('argon2');
const { db, initDatabase, closeDatabase } = require('../database/db');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// 將資料庫操作包裝為 Promise
function dbGet(query, params) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbRun(query, params) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

async function createAdmin() {
    try {
        // 初始化資料庫
        await initDatabase();
        console.log('資料庫已初始化\n');

        // 獲取使用者輸入
        const username = process.argv[2] || await question('請輸入使用者名稱: ');
        const password = process.argv[3] || await question('請輸入密碼: ');
        const fullName = await question('請輸入姓名（選填）: ');
        const email = await question('請輸入電子郵件（選填）: ');

        if (!username || !password) {
            console.error('錯誤: 使用者名稱和密碼為必填');
            rl.close();
            await closeDatabase();
            process.exit(1);
        }

        if (password.length < 6) {
            console.error('錯誤: 密碼至少需要 6 個字元');
            rl.close();
            await closeDatabase();
            process.exit(1);
        }

        // 檢查使用者是否已存在
        const existingUser = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
        
        if (existingUser) {
            console.error(`錯誤: 使用者名稱 "${username}" 已存在`);
            rl.close();
            await closeDatabase();
            process.exit(1);
        }

        // 使用 argon2id 加密密碼
        console.log('正在加密密碼...');
        const passwordHash = await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65536, // 64 MB
            timeCost: 3, // 迭代次數
            parallelism: 4 // 並行度
        });

        // 插入使用者
        await dbRun(
            `INSERT INTO users (username, password_hash, full_name, email, role, is_active) 
             VALUES (?, ?, ?, ?, 'admin', 1)`,
            [username, passwordHash, fullName || null, email || null]
        );

        console.log('\n✅ 管理員帳號已成功創建！');
        console.log(`   使用者名稱: ${username}`);
        console.log(`   角色: 管理員`);
        if (fullName) console.log(`   姓名: ${fullName}`);
        if (email) console.log(`   電子郵件: ${email}`);
        console.log('\n現在可以使用此帳號登入系統。');
        
    } catch (error) {
        console.error('錯誤:', error.message || error);
        process.exit(1);
    } finally {
        rl.close();
        await closeDatabase();
    }
}

// 執行
createAdmin();

