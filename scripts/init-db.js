const { initDatabase, closeDatabase } = require('../database/db');

async function main() {
    try {
        console.log('開始初始化資料庫...');
        await initDatabase();
        console.log('資料庫初始化完成！');
        await closeDatabase();
        process.exit(0);
    } catch (error) {
        console.error('初始化失敗:', error);
        process.exit(1);
    }
}

main();
