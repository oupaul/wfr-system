#!/bin/bash
# 資金週報系統安裝腳本

echo "========================================="
echo "  資金週報系統 - 安裝腳本"
echo "========================================="
echo ""

# 檢查 Node.js 是否已安裝
if ! command -v node &> /dev/null; then
    echo "❌ 未檢測到 Node.js"
    echo "請先安裝 Node.js 18.x 或更高版本："
    echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

echo "✓ Node.js 版本: $(node --version)"
echo "✓ npm 版本: $(npm --version)"
echo ""

# 安裝依賴
echo "正在安裝依賴套件..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ 依賴安裝失敗"
    exit 1
fi

echo "✓ 依賴套件安裝完成"
echo ""

# 初始化資料庫
echo "正在初始化資料庫..."
npm run init-db

if [ $? -ne 0 ]; then
    echo "❌ 資料庫初始化失敗"
    exit 1
fi

echo "✓ 資料庫初始化完成"
echo ""
echo "========================================="
echo "  安裝完成！"
echo "========================================="
echo ""
echo "接下來的步驟："
echo "1. 匯入 Excel 檔案："
echo "   npm run import-excel"
echo ""
echo "2. 啟動伺服器："
echo "   npm start"
echo ""
echo "3. 開啟瀏覽器訪問："
echo "   http://localhost:3000"
echo ""
