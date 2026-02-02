#!/bin/bash
# 資金週報系統 - 一鍵安裝腳本

set -e  # 遇到錯誤立即退出

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 自動修復當前腳本的換行符問題（Windows CRLF -> Linux LF）
# 使用 sed 修復當前腳本文件本身
if command -v sed &> /dev/null; then
    sed -i 's/\r$//' "$0" 2>/dev/null || true
fi
# 如果有 dos2unix，也嘗試使用
if command -v dos2unix &> /dev/null; then
    dos2unix "$0" 2>/dev/null || true
fi

echo "========================================="
echo "  資金週報系統 - 一鍵安裝"
echo "========================================="
echo ""

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 預設值
DEFAULT_PORT=3000
DEFAULT_TITLE="資金週報系統"
DEFAULT_DEPLOY_PATH="/opt/fund-weekly-report"
DEFAULT_INSTALL_TO_OPT=false

# 配置變數
INSTALL_PORT=""
INSTALL_TITLE=""
DEPLOY_PATH=""
INSTALL_TO_OPT=false
ENABLE_SERVICE=false

# 檢查是否為 root 用戶（部署到 /opt 需要 root）
echo "配置選項："
echo ""
echo -e "${BLUE}[1] 部署路徑選擇${NC}"
echo "  [1] 部署到當前目錄（推薦用於開發）"
echo "  [2] 部署到 /opt（推薦用於生產環境，需要 root 權限）"
read -p "請選擇部署方式 (1/2，預設 1): " deploy_choice
deploy_choice=${deploy_choice:-1}

if [ "$deploy_choice" = "2" ]; then
    INSTALL_TO_OPT=true
    
    # 檢查 root 權限
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}❌ 部署到 /opt 需要 root 權限${NC}"
        echo "請使用 sudo 執行此腳本："
        echo "  sudo ./install.sh"
        exit 1
    fi
    
    # 自定義資料夾名稱
    read -p "請輸入資料夾名稱（預設：fund-weekly-report）: " folder_name
    folder_name=${folder_name:-fund-weekly-report}
    DEPLOY_PATH="/opt/$folder_name"
    
    echo -e "${GREEN}✓ 將部署到: $DEPLOY_PATH${NC}"
else
    DEPLOY_PATH="$SCRIPT_DIR"
    echo -e "${GREEN}✓ 將部署到當前目錄: $DEPLOY_PATH${NC}"
fi

echo ""
echo -e "${BLUE}[2] 服務端口配置${NC}"
read -p "請輸入服務端口（預設 $DEFAULT_PORT）: " input_port
INSTALL_PORT=${input_port:-$DEFAULT_PORT}

# 驗證端口是否為數字且在有效範圍內
if ! [[ "$INSTALL_PORT" =~ ^[0-9]+$ ]] || [ "$INSTALL_PORT" -lt 1 ] || [ "$INSTALL_PORT" -gt 65535 ]; then
    echo -e "${RED}❌ 無效的端口號，使用預設值 $DEFAULT_PORT${NC}"
    INSTALL_PORT=$DEFAULT_PORT
fi

echo -e "${GREEN}✓ 服務端口: $INSTALL_PORT${NC}"

echo ""
echo -e "${BLUE}[3] 瀏覽器標題配置${NC}"
read -p "請輸入瀏覽器標題（預設：$DEFAULT_TITLE）: " input_title
INSTALL_TITLE=${input_title:-$DEFAULT_TITLE}
echo -e "${GREEN}✓ 瀏覽器標題: $INSTALL_TITLE${NC}"

echo ""
echo -e "${BLUE}[4] 收支記錄功能模式${NC}"
echo "  1) 完整功能（收入 + 支出）"
echo "  2) 僅支出功能"
read -p "請選擇功能模式 (1/2，預設：1): " mode_choice
case $mode_choice in
    2)
        TRANSACTION_MODE="expense_only"
        echo -e "${GREEN}✓ 功能模式: 僅支出${NC}"
        ;;
    *)
        TRANSACTION_MODE="full"
        echo -e "${GREEN}✓ 功能模式: 完整功能（收入 + 支出）${NC}"
        ;;
esac

echo ""
echo -e "${BLUE}[5] 閒置登出時間配置${NC}"
echo "  設定使用者閒置多久後自動登出（分鐘）"
read -p "請輸入閒置時間（預設：30 分鐘）: " idle_timeout
IDLE_TIMEOUT=${idle_timeout:-30}
echo -e "${GREEN}✓ 閒置登出時間: $IDLE_TIMEOUT 分鐘${NC}"

echo ""
echo -e "${BLUE}[6] 自動備份排程配置${NC}"
echo "  設定每日自動備份資料庫的時間"
echo "  1) 不啟用自動備份"
echo "  2) 每日 00:00 備份"
echo "  3) 每日 02:00 備份"
echo "  4) 每日 04:00 備份"
echo "  5) 自定義時間"
read -p "請選擇 (1-5，預設：1): " backup_choice
backup_choice=${backup_choice:-1}

ENABLE_BACKUP=false
BACKUP_HOUR=""
BACKUP_MINUTE=""

case $backup_choice in
    2)
        ENABLE_BACKUP=true
        BACKUP_HOUR="0"
        BACKUP_MINUTE="0"
        echo -e "${GREEN}✓ 每日 00:00 自動備份${NC}"
        ;;
    3)
        ENABLE_BACKUP=true
        BACKUP_HOUR="2"
        BACKUP_MINUTE="0"
        echo -e "${GREEN}✓ 每日 02:00 自動備份${NC}"
        ;;
    4)
        ENABLE_BACKUP=true
        BACKUP_HOUR="4"
        BACKUP_MINUTE="0"
        echo -e "${GREEN}✓ 每日 04:00 自動備份${NC}"
        ;;
    5)
        ENABLE_BACKUP=true
        read -p "請輸入小時（0-23）: " custom_hour
        read -p "請輸入分鐘（0-59）: " custom_minute
        BACKUP_HOUR=${custom_hour:-0}
        BACKUP_MINUTE=${custom_minute:-0}
        echo -e "${GREEN}✓ 每日 $(printf "%02d:%02d" $BACKUP_HOUR $BACKUP_MINUTE) 自動備份${NC}"
        ;;
    *)
        echo -e "${YELLOW}✓ 不啟用自動備份${NC}"
        ;;
esac

# 備份目錄位置（部署到 /opt 時可選獨立目錄並自訂名稱）
BACKUP_PATH=""
if [ "$INSTALL_TO_OPT" = true ]; then
    echo ""
    echo -e "${BLUE}[6b] 備份目錄位置（部署到 /opt 時）${NC}"
    echo "  1) 應用目錄下 backups（$DEPLOY_PATH/backups）"
    echo "  2) /opt 下獨立目錄（可自訂資料夾名稱，與應用分開保存，建議）"
    read -p "請選擇備份目錄 (1/2，預設：2): " backup_dir_choice
    backup_dir_choice=${backup_dir_choice:-2}
    if [ "$backup_dir_choice" = "2" ]; then
        read -p "請輸入 /opt 下備份資料夾名稱（預設：fund-weekly-report-backups）: " backup_folder_name
        backup_folder_name=${backup_folder_name:-fund-weekly-report-backups}
        BACKUP_PATH="/opt/$backup_folder_name"
        echo -e "${GREEN}✓ 備份目錄: $BACKUP_PATH${NC}"
    else
        BACKUP_PATH="$DEPLOY_PATH/backups"
        echo -e "${GREEN}✓ 備份目錄: $BACKUP_PATH${NC}"
    fi
else
    BACKUP_PATH="$DEPLOY_PATH/backups"
fi

echo ""
echo -e "${BLUE}[7] 常駐服務配置${NC}"
SERVICE_NAME="fund-weekly-report"
if [ "$INSTALL_TO_OPT" = true ]; then
    echo "  檢測到部署到 /opt，建議配置為 systemd 常駐服務"
    read -p "是否配置為 systemd 常駐服務並自動啟動? (Y/n): " service_choice
    if [[ ! $service_choice =~ ^[Nn]$ ]]; then
        ENABLE_SERVICE=true
        if [ "$EUID" -ne 0 ]; then
            echo -e "${RED}❌ 配置 systemd 服務需要 root 權限${NC}"
            ENABLE_SERVICE=false
        fi
    fi
else
    read -p "是否配置為 systemd 常駐服務並自動啟動? (y/N): " service_choice
    if [[ $service_choice =~ ^[Yy]$ ]]; then
        ENABLE_SERVICE=true
        if [ "$EUID" -ne 0 ]; then
            echo -e "${RED}❌ 配置 systemd 服務需要 root 權限${NC}"
            echo "請使用 sudo 執行此腳本以配置服務"
            ENABLE_SERVICE=false
        fi
    fi
fi

if [ "$ENABLE_SERVICE" = true ]; then
    echo ""
    read -p "請輸入服務名稱（預設：fund-weekly-report）: " input_service_name
    SERVICE_NAME=${input_service_name:-fund-weekly-report}
    echo -e "${GREEN}✓ 將配置為 systemd 常駐服務（服務名稱：${SERVICE_NAME}）${NC}"
fi

echo ""
read -p "確認以上配置? (Y/n): " confirm
if [[ $confirm =~ ^[Nn]$ ]]; then
    echo "安裝已取消"
    exit 0
fi

echo ""
echo "========================================="
echo "  開始安裝..."
echo "========================================="
echo ""

# 如果需要部署到 /opt，先複製檔案
if [ "$INSTALL_TO_OPT" = true ]; then
    echo "正在複製檔案到 $DEPLOY_PATH..."
    
    # 確保目標目錄不存在或為空
    if [ -d "$DEPLOY_PATH" ] && [ "$(ls -A $DEPLOY_PATH 2>/dev/null)" ]; then
        echo -e "${YELLOW}目標目錄已存在且不為空${NC}"
        read -p "是否要覆蓋現有檔案? (yes/NO): " overwrite
        if [ "$overwrite" != "yes" ]; then
            echo "取消安裝"
            exit 0
        fi
        echo "正在清理目標目錄..."
        rm -rf "$DEPLOY_PATH"
    fi
    
    # 創建目標目錄
    mkdir -p "$DEPLOY_PATH"
    
    # 使用 rsync 複製檔案（如果有的話）
    if command -v rsync &> /dev/null; then
        echo "使用 rsync 複製檔案..."
        rsync -av --exclude='.git' --exclude='node_modules' --exclude='*.log' \
              "$SCRIPT_DIR/" "$DEPLOY_PATH/" 2>&1 | grep -v "sending incremental file list" || true
    else
        echo "使用 cp 複製檔案..."
        # 複製所有檔案（包括隱藏檔案）
        cp -a "$SCRIPT_DIR/." "$DEPLOY_PATH/"
    fi
    
    # 驗證複製結果
    if [ ! -f "$DEPLOY_PATH/package.json" ] || [ ! -f "$DEPLOY_PATH/server.js" ]; then
        echo -e "${RED}❌ 檔案複製失敗，找不到必要的檔案${NC}"
        exit 1
    fi
    
    # 切換到目標目錄
    cd "$DEPLOY_PATH"
    echo -e "${GREEN}✓ 檔案已複製到: $DEPLOY_PATH${NC}"
    echo ""
fi

# 1. 檢查 Node.js
echo "1. 檢查 Node.js..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ 未檢測到 Node.js${NC}"
    echo ""
    echo "請選擇安裝方式:"
    echo "  [1] 使用 NodeSource (推薦)"
    echo "  [2] 使用 apt (Ubuntu 預設版本)"
    echo "  [3] 手動安裝後重新執行此腳本"
    read -p "請選擇 (1/2/3): " choice
    
    case $choice in
        1)
            echo "正在從 NodeSource 安裝 Node.js 18.x..."
            curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
            apt-get install -y nodejs
            ;;
        2)
            echo "正在從 apt 安裝 Node.js..."
            apt-get update
            apt-get install -y nodejs npm
            ;;
        3)
            echo "請先安裝 Node.js，然後重新執行此腳本"
            exit 1
            ;;
        *)
            echo "無效選擇，退出安裝"
            exit 1
            ;;
    esac
fi

NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
echo -e "${GREEN}✓ Node.js 版本: $NODE_VERSION${NC}"
echo -e "${GREEN}✓ npm 版本: $NPM_VERSION${NC}"

# 檢查 Node.js 版本是否 >= 18
NODE_MAJOR_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 版本需要 18.x 或更高版本${NC}"
    echo "目前版本: $NODE_VERSION"
    exit 1
fi

echo ""

# 2. 安裝依賴
echo "2. 安裝專案依賴套件..."
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ 找不到 package.json 檔案${NC}"
    exit 1
fi

npm install

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 依賴安裝失敗${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 依賴套件安裝完成${NC}"
echo ""

# 3. 初始化資料庫
echo "3. 初始化資料庫..."
npm run init-db

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 資料庫初始化失敗${NC}"
    exit 1
fi

echo -e "${GREEN}✓ 資料庫初始化完成${NC}"
echo ""

# 3.5. 創建預設管理員帳號
echo "3.5. 創建預設管理員帳號..."
echo "   使用者名稱: admin"
echo "   密碼: admin123"
echo "   角色: 管理員"

# 使用 Node.js 直接創建管理員（避免互動式輸入）
node -e "
const argon2 = require('argon2');
const { db, initDatabase } = require('./database/db');

async function createDefaultAdmin() {
    try {
        await initDatabase();
        
        // 檢查 admin 帳號是否已存在
        const existingUser = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (existingUser) {
            console.log('⚠ admin 帳號已存在，跳過創建');
            process.exit(0);
        }
        
        // 加密密碼
        const passwordHash = await argon2.hash('admin123', {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 4
        });
        
        // 創建管理員
        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
                ['admin', passwordHash, '系統管理員', 'admin', 1],
                function(err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });
        
        console.log('✓ 預設管理員帳號創建成功');
        process.exit(0);
    } catch (error) {
        console.error('創建管理員失敗:', error.message);
        process.exit(1);
    }
}

createDefaultAdmin();
" 2>/dev/null

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ 預設管理員帳號已創建${NC}"
    echo -e "${YELLOW}   重要：首次登入後請立即修改密碼！${NC}"
else
    echo -e "${YELLOW}⚠ 管理員帳號創建失敗，請手動執行：${NC}"
    echo "   node scripts/create-admin.js admin admin123"
fi
echo ""

# 4. 建立環境配置檔案
echo "4. 建立環境配置檔案..."
cat > .env << EOF
# 資金週報系統環境配置
PORT=$INSTALL_PORT
HOST=0.0.0.0
NODE_ENV=production
APP_TITLE=$INSTALL_TITLE
DEPLOY_PATH=$DEPLOY_PATH

# 收支記錄功能模式：full（完整功能）或 expense_only（僅支出）
TRANSACTION_MODE=$TRANSACTION_MODE

# Session 配置
SESSION_TIMEOUT=$((IDLE_TIMEOUT * 60 * 1000))  # 閒置登出時間（毫秒）

# 資料庫路徑（相對路徑）
DB_PATH=database/fund_report.db

# 備份路徑（可為應用下 backups 或 /opt 下自訂目錄）
BACKUP_PATH=$BACKUP_PATH
EOF
echo -e "${GREEN}✓ 環境配置檔案已建立${NC}"
echo ""

# 5. 更新 HTML 標題（標題會由前端動態載入，這裡僅更新初始值）
echo "5. 更新網頁標題..."
if [ -f "public/index.html" ]; then
    # 僅更新 <title> 標籤，頁面內的標題會由 JavaScript 動態更新
    # 使用 Perl 進行更安全的替換，避免特殊字符問題
    if command -v perl &> /dev/null; then
        perl -i -pe "s/<title>.*?<\/title>/<title>$INSTALL_TITLE<\/title>/" public/index.html
    else
        # 如果沒有 Perl，使用 sed（需要轉義特殊字符）
        INSTALL_TITLE_ESCAPED=$(echo "$INSTALL_TITLE" | sed 's/[\/&]/\\&/g')
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/<title>.*<\/title>/<title>$INSTALL_TITLE_ESCAPED<\/title>/" public/index.html
        else
            # Linux
            sed -i "s/<title>.*<\/title>/<title>$INSTALL_TITLE_ESCAPED<\/title>/" public/index.html
        fi
    fi
    echo -e "${GREEN}✓ 網頁標題已更新${NC}"
else
    echo -e "${YELLOW}⚠ 找不到 public/index.html，跳過標題更新${NC}"
fi
echo ""

# 6. 設定檔案權限
echo "6. 設定檔案權限..."
chmod +x install.sh uninstall.sh backup.sh restore.sh 2>/dev/null || true
chmod +x scripts/*.js 2>/dev/null || true
echo -e "${GREEN}✓ 檔案權限設定完成${NC}"
echo ""

# 7. 建立配置記錄檔案（用於其他腳本）
echo "7. 建立配置記錄..."
cat > .install-config << EOF
DEPLOY_PATH=$DEPLOY_PATH
BACKUP_PATH=$BACKUP_PATH
INSTALL_PORT=$INSTALL_PORT
INSTALL_TITLE=$INSTALL_TITLE
INSTALL_TO_OPT=$INSTALL_TO_OPT
ENABLE_SERVICE=$ENABLE_SERVICE
INSTALL_DATE=$(date +%Y-%m-%d\ %H:%M:%S)
EOF
echo -e "${GREEN}✓ 配置記錄已建立${NC}"
echo ""

# 8. 配置 systemd 服務（如果需要）
if [ "$ENABLE_SERVICE" = true ]; then
    echo "8. 配置 systemd 常駐服務..."
    
    # 獲取 Node.js 和 npm 的完整路徑
    NODE_PATH=$(which node)
    NPM_PATH=$(which npm)
    
    # 建立 systemd 服務檔案
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    
    # 確定運行用戶（優先使用當前用戶，如果沒有則使用部署目錄的擁有者）
    if [ -z "$SUDO_USER" ]; then
        RUN_USER="$USER"
    else
        RUN_USER="$SUDO_USER"
    fi
    
    # 如果用戶不存在，使用部署目錄的擁有者
    if ! id "$RUN_USER" &>/dev/null; then
        RUN_USER=$(stat -c '%U' "$DEPLOY_PATH" 2>/dev/null || echo "root")
    fi
    
    cat > "$SERVICE_FILE" << EOF
[Unit]
Description=資金週報系統 (Fund Weekly Report System)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DEPLOY_PATH
Environment="NODE_ENV=production"
Environment="PORT=$INSTALL_PORT"
Environment="HOST=0.0.0.0"
Environment="APP_TITLE=$INSTALL_TITLE"
Environment="TRANSACTION_MODE=$TRANSACTION_MODE"
Environment="DEPLOY_PATH=$DEPLOY_PATH"
Environment="BACKUP_PATH=$BACKUP_PATH"
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

    # 重新載入 systemd
    systemctl daemon-reload
    
    # 啟用服務（開機自動啟動）
    systemctl enable "${SERVICE_NAME}.service"
    
    # 啟動服務
    systemctl start "${SERVICE_NAME}.service"
    
    # 檢查服務狀態
    sleep 2
    if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
        echo -e "${GREEN}✓ systemd 服務已配置並啟動成功${NC}"
    else
        echo -e "${YELLOW}⚠ 服務配置完成，但啟動可能失敗，請檢查狀態：${NC}"
        echo "  ${YELLOW}systemctl status ${SERVICE_NAME}.service${NC}"
    fi
    echo ""
fi

# 配置自動備份 cron job
if [ "$ENABLE_BACKUP" = true ]; then
    echo "7. 配置自動備份排程..."
    
    # 創建備份目錄（支援 /opt 下獨立目錄）
    mkdir -p "$BACKUP_PATH"
    if [ "$INSTALL_TO_OPT" = true ] && [[ "$BACKUP_PATH" == /opt/* ]]; then
        # 若備份目錄在 /opt 下，確保執行用戶可寫入（cron 以該用戶執行時需有權限）
        BACKUP_OWNER="${SUDO_USER:-$(stat -c '%U' "$DEPLOY_PATH" 2>/dev/null || echo '')}"
        if [ -n "$BACKUP_OWNER" ] && [ "$BACKUP_OWNER" != "root" ]; then
            chown "$BACKUP_OWNER" "$BACKUP_PATH" 2>/dev/null || true
        fi
    fi
    
    # 創建 cron job（backup.sh 會從 .install-config 讀取 BACKUP_PATH）
    CRON_COMMAND="$BACKUP_MINUTE $BACKUP_HOUR * * * cd $DEPLOY_PATH && ./backup.sh > /dev/null 2>&1"
    
    # 檢查 cron job 是否已存在
    if crontab -l 2>/dev/null | grep -q "$DEPLOY_PATH.*backup.sh"; then
        echo -e "${YELLOW}⚠ 自動備份排程已存在${NC}"
    else
        # 添加 cron job
        (crontab -l 2>/dev/null; echo "$CRON_COMMAND") | crontab -
        echo -e "${GREEN}✓ 自動備份排程已配置: 每日 $(printf "%02d:%02d" $BACKUP_HOUR $BACKUP_MINUTE)${NC}"
    fi
    echo ""
fi

echo "========================================="
echo -e "${GREEN}  安裝完成！${NC}"
echo "========================================="
echo ""
echo "安裝資訊："
echo "  部署路徑: $DEPLOY_PATH"
echo "  備份目錄: $BACKUP_PATH"
echo "  服務端口: $INSTALL_PORT"
echo "  瀏覽器標題: $INSTALL_TITLE"
if [ "$ENABLE_SERVICE" = true ]; then
    echo "  常駐服務: 已配置並啟動"
    echo "  服務名稱: ${SERVICE_NAME}.service"
fi
echo ""
echo -e "${YELLOW}預設管理員帳號：${NC}"
echo "  使用者名稱: admin"
echo "  密碼: admin123"
echo -e "  ${RED}⚠️  重要：首次登入後請立即修改密碼！${NC}"
echo ""
echo "接下來的步驟："
echo ""
echo "1. 登入系統："
echo "   使用瀏覽器開啟系統網址"
echo "   使用預設管理員帳號登入"
echo ""
echo "2. 匯入 Excel 檔案："
if [ "$INSTALL_TO_OPT" = true ]; then
    echo "   cd $DEPLOY_PATH"
fi
echo "   ${YELLOW}npm run import-excel${NC}"
echo "   或查看 Excel 結構："
echo "   ${YELLOW}node scripts/import-excel.js --show-structure${NC}"
echo ""

if [ "$ENABLE_SERVICE" = true ]; then
    echo "3. 服務已自動啟動，您可以訪問："
    echo "   本地訪問: ${YELLOW}http://localhost:$INSTALL_PORT${NC}"
    # 獲取本機 IP 地址
    if command -v hostname &> /dev/null; then
        IP_ADDRESS=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "")
        if [ ! -z "$IP_ADDRESS" ]; then
            echo "   外部訪問: ${YELLOW}http://$IP_ADDRESS:$INSTALL_PORT${NC}"
            echo "   （同一網路內的其他設備可使用此地址訪問）"
        fi
    fi
    echo ""
    echo "服務管理命令："
    echo "  查看狀態: ${YELLOW}systemctl status ${SERVICE_NAME}.service${NC}"
    echo "  停止服務: ${YELLOW}systemctl stop ${SERVICE_NAME}.service${NC}"
    echo "  啟動服務: ${YELLOW}systemctl start ${SERVICE_NAME}.service${NC}"
    echo "  重啟服務: ${YELLOW}systemctl restart ${SERVICE_NAME}.service${NC}"
    echo "  查看日誌: ${YELLOW}journalctl -u ${SERVICE_NAME}.service -f${NC}"
    echo ""
else
    echo "3. 啟動伺服器："
    echo "   ${YELLOW}npm start${NC}"
    echo ""
    echo "4. 開啟瀏覽器訪問："
    echo "   本地訪問: ${YELLOW}http://localhost:$INSTALL_PORT${NC}"
    # 獲取本機 IP 地址
    if command -v hostname &> /dev/null; then
        IP_ADDRESS=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "")
        if [ ! -z "$IP_ADDRESS" ]; then
            echo "   外部訪問: ${YELLOW}http://$IP_ADDRESS:$INSTALL_PORT${NC}"
            echo "   （同一網路內的其他設備可使用此地址訪問）"
        fi
    fi
    echo ""
    echo "4. 開發模式（自動重啟）："
    echo "   ${YELLOW}npm run dev${NC}"
    echo ""
fi

echo "其他可用腳本："
echo "  - ${YELLOW}./backup.sh${NC}     : 備份資料庫"
echo "  - ${YELLOW}./restore.sh${NC}    : 還原資料庫"
echo "  - ${YELLOW}./uninstall.sh${NC}  : 移除系統"
echo ""
if [ "$INSTALL_TO_OPT" = true ]; then
    echo -e "${YELLOW}注意：系統已部署到 $DEPLOY_PATH${NC}"
    echo "所有腳本需要在該目錄下執行"
    echo ""
fi
