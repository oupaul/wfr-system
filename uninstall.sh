#!/bin/bash
# 資金週報系統 - 一鍵移除腳本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 自動修復換行符問題（Windows CRLF -> Linux LF）
if command -v dos2unix &> /dev/null; then
    dos2unix "$0" 2>/dev/null || true
elif command -v sed &> /dev/null; then
    sed -i 's/\r$//' "$0" 2>/dev/null || true
fi

echo "========================================="
echo "  資金週報系統 - 一鍵移除"
echo "========================================="
echo ""

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 收集所有可能的安裝目錄
INSTALL_DIRS=()

# 1. 當前目錄（如果包含必要的檔案）
if [ -f "package.json" ] && [ -f "server.js" ]; then
    INSTALL_DIRS+=("$SCRIPT_DIR")
fi

# 2. 掃描 /opt 目錄下的所有可能的安裝
if [ -d "/opt" ] && [ -r "/opt" ]; then
    for dir in /opt/*/; do
        if [ -d "$dir" ] && [ -f "$dir/package.json" ] && [ -f "$dir/server.js" ]; then
            INSTALL_DIRS+=("$dir")
        fi
    done
fi

# 3. 檢查 .install-config 中配置的目錄
if [ -f ".install-config" ]; then
    # 安全地讀取 DEPLOY_PATH（不使用 source，避免執行時間戳記等命令）
    CONFIG_DEPLOY_PATH=$(grep "^DEPLOY_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    if [ -n "$CONFIG_DEPLOY_PATH" ] && [ -d "$CONFIG_DEPLOY_PATH" ] && [ -f "$CONFIG_DEPLOY_PATH/package.json" ]; then
        # 如果配置的目錄不在列表中，加入列表
        found=false
        for dir in "${INSTALL_DIRS[@]}"; do
            if [ "$dir" = "$CONFIG_DEPLOY_PATH" ]; then
                found=true
                break
            fi
        done
        if [ "$found" = false ]; then
            INSTALL_DIRS+=("$CONFIG_DEPLOY_PATH")
        fi
    fi
fi

# 如果沒有找到任何安裝
if [ ${#INSTALL_DIRS[@]} -eq 0 ]; then
    echo -e "${RED}❌ 未找到任何資金週報系統安裝${NC}"
    echo ""
    echo "請確認："
    echo "  1. 當前目錄是否包含 package.json 和 server.js"
    echo "  2. /opt 目錄下是否有相關安裝"
    exit 1
fi

# 顯示可用的安裝目錄
echo "找到以下安裝目錄："
echo ""
for i in "${!INSTALL_DIRS[@]}"; do
    DIR="${INSTALL_DIRS[$i]}"
    SIZE=""
    if [ -d "$DIR" ]; then
        SIZE=$(du -sh "$DIR" 2>/dev/null | cut -f1 || echo "未知")
    fi
    echo "  [$((i+1))] $DIR"
    echo "      大小: $SIZE"
    
    # 檢查是否有執行中的服務
    if [ -f "$DIR/.env" ]; then
        PORT=$(grep "^PORT=" "$DIR/.env" 2>/dev/null | cut -d'=' -f2 || echo "")
        if [ ! -z "$PORT" ]; then
            SERVER_PID=$(lsof -ti:$PORT 2>/dev/null || true)
            if [ ! -z "$SERVER_PID" ]; then
                echo -e "      狀態: ${YELLOW}運行中 (PID: $SERVER_PID, Port: $PORT)${NC}"
            else
                echo "      狀態: 未運行"
            fi
        fi
    fi
    echo ""
done

# 讓用戶選擇要移除的目錄
if [ ${#INSTALL_DIRS[@]} -eq 1 ]; then
    SELECTED_DIR="${INSTALL_DIRS[0]}"
    echo "僅找到一個安裝，將移除: $SELECTED_DIR"
    read -p "確認繼續? (Y/n): " confirm
    if [[ $confirm =~ ^[Nn]$ ]]; then
        echo "取消操作"
        exit 0
    fi
else
    read -p "請選擇要移除的安裝編號 (1-${#INSTALL_DIRS[@]}): " choice
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#INSTALL_DIRS[@]} ]; then
        echo -e "${RED}❌ 無效的選擇${NC}"
        exit 1
    fi
    SELECTED_DIR="${INSTALL_DIRS[$((choice-1))]}"
fi

# 轉換到選定的目錄
cd "$SELECTED_DIR"
CURRENT_DIR=$(pwd)

echo ""
echo "========================================="
echo "  準備移除: $CURRENT_DIR"
echo "========================================="
echo ""

# 警告訊息
echo -e "${YELLOW}⚠️  警告：此操作將移除以下內容：${NC}"
echo "  目錄: $CURRENT_DIR"
echo "  - node_modules/ 目錄"
echo "  - database/fund_report.db 資料庫檔案"
echo "  - .env 環境配置檔案（如果存在）"
echo "  - .install-config 配置記錄檔案（如果存在）"
if [[ "$CURRENT_DIR" == /opt/* ]]; then
    echo -e "${RED}  - 整個部署目錄（可選）${NC}"
fi
echo ""

read -p "確定要移除此安裝嗎? (yes/NO): " confirm

if [ "$confirm" != "yes" ]; then
    echo "取消移除操作"
    exit 0
fi

echo ""
echo "開始移除..."

# 1. 檢查並停止服務
echo "1. 檢查並停止服務..."

# 檢查是否有 systemd 服務
SERVICE_NAME="fund-weekly-report"
if systemctl list-unit-files | grep -q "${SERVICE_NAME}.service"; then
    if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
        echo -e "${YELLOW}發現 systemd 服務正在運行${NC}"
        read -p "是否要停止並移除 systemd 服務? (Y/n): " stop_service
        if [[ ! $stop_service =~ ^[Nn]$ ]]; then
            echo "正在停止服務..."
            systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
            systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
            echo -e "${GREEN}✓ systemd 服務已停止${NC}"
        fi
    fi
    
    read -p "是否要移除 systemd 服務檔案? (Y/n): " remove_service_file
    if [[ ! $remove_service_file =~ ^[Nn]$ ]]; then
        if [ "$EUID" -eq 0 ]; then
            rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
            systemctl daemon-reload
            echo -e "${GREEN}✓ systemd 服務檔案已移除${NC}"
        else
            echo -e "${YELLOW}需要 root 權限才能移除服務檔案${NC}"
            echo "請手動執行: sudo rm -f /etc/systemd/system/${SERVICE_NAME}.service"
        fi
    fi
fi

# 檢查是否有執行中的進程（非 systemd 管理）
if [ -f ".env" ]; then
    PORT=$(grep "^PORT=" .env 2>/dev/null | cut -d'=' -f2 || echo "3000")
else
    PORT="3000"
fi

SERVER_PID=$(lsof -ti:$PORT 2>/dev/null | head -1 || true)
if [ ! -z "$SERVER_PID" ]; then
    echo -e "${YELLOW}發現執行中的伺服器進程 (PID: $SERVER_PID, Port: $PORT)${NC}"
    read -p "是否要停止此進程? (Y/n): " stop_server
    if [[ ! $stop_server =~ ^[Nn]$ ]]; then
        echo "正在停止伺服器..."
        kill $SERVER_PID 2>/dev/null || true
        sleep 2
        echo -e "${GREEN}✓ 伺服器進程已停止${NC}"
    fi
fi
echo ""

# 2. 詢問是否備份資料庫
echo "2. 資料庫備份選項..."
if [ -f "database/fund_report.db" ]; then
    read -p "是否要先備份資料庫? (Y/n): " backup_choice
    if [[ ! $backup_choice =~ ^[Nn]$ ]]; then
        echo ""
        echo "選擇備份位置："
        echo ""
        
        # 列出 /opt 下的備份目錄
        BACKUP_DIRS=()
        if [ -d "/opt" ] && [ -r "/opt" ]; then
            echo "現有的備份目錄："
            for dir in /opt/*/; do
                if [ -d "$dir" ]; then
                    dir_name=$(basename "$dir")
                    # 顯示包含 backup 或 已有 .db 檔案的目錄
                    if [[ "$dir_name" == *backup* ]] || ls "$dir"*.db &>/dev/null; then
                        BACKUP_DIRS+=("$dir")
                        echo "  [${#BACKUP_DIRS[@]}] $dir"
                    fi
                fi
            done
        fi
        
        echo ""
        if [ ${#BACKUP_DIRS[@]} -gt 0 ]; then
            echo "  [0] 創建新的備份資料夾"
            echo ""
            read -p "請選擇備份目錄 (0-${#BACKUP_DIRS[@]}): " backup_dir_choice
            
            if [ "$backup_dir_choice" = "0" ]; then
                # 創建新的備份資料夾
                read -p "請輸入新備份資料夾名稱（例如：wfr-backups）: " new_backup_name
                new_backup_name=${new_backup_name:-fund-weekly-report-backups}
                SYSTEM_BACKUP_DIR="/opt/$new_backup_name"
                echo "將備份到: $SYSTEM_BACKUP_DIR"
            elif [[ "$backup_dir_choice" =~ ^[0-9]+$ ]] && [ "$backup_dir_choice" -ge 1 ] && [ "$backup_dir_choice" -le ${#BACKUP_DIRS[@]} ]; then
                SYSTEM_BACKUP_DIR="${BACKUP_DIRS[$((backup_dir_choice-1))]}"
                SYSTEM_BACKUP_DIR="${SYSTEM_BACKUP_DIR%/}"  # 移除結尾的斜線
                echo "將備份到: $SYSTEM_BACKUP_DIR"
            else
                echo -e "${YELLOW}無效選擇，使用預設備份目錄${NC}"
                SYSTEM_BACKUP_DIR="/opt/fund-weekly-report-backups"
            fi
        else
            echo "未找到現有備份目錄"
            read -p "請輸入備份資料夾名稱（預設：fund-weekly-report-backups）: " new_backup_name
            new_backup_name=${new_backup_name:-fund-weekly-report-backups}
            SYSTEM_BACKUP_DIR="/opt/$new_backup_name"
            echo "將備份到: $SYSTEM_BACKUP_DIR"
        fi
        
        echo ""
        
        # 檢查是否有權限創建/寫入 /opt 目錄
        if [ ! -w "/opt" ] && [ "$EUID" -ne 0 ]; then
            echo -e "${YELLOW}需要 root 權限才能備份到 /opt 目錄${NC}"
            read -p "是否要使用 sudo 權限備份? (Y/n): " use_sudo
            if [[ ! $use_sudo =~ ^[Nn]$ ]]; then
                # 使用 sudo 創建備份目錄並備份
                sudo mkdir -p "$SYSTEM_BACKUP_DIR"
                if [ $? -eq 0 ]; then
                    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                    BACKUP_FILE="$SYSTEM_BACKUP_DIR/fund_report_${TIMESTAMP}.db"
                    sudo cp "database/fund_report.db" "$BACKUP_FILE"
                    sudo chmod 644 "$BACKUP_FILE"
                    # 驗證備份檔案
                    ORIGINAL_SIZE=$(du -b "database/fund_report.db" 2>/dev/null | cut -f1 || echo "0")
                    BACKUP_SIZE=$(sudo du -b "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "0")
                    if [ "$BACKUP_SIZE" != "0" ] && [ "$BACKUP_SIZE" = "$ORIGINAL_SIZE" ]; then
                        echo -e "${GREEN}✓ 資料庫已備份至: $BACKUP_FILE${NC}"
                        echo "  備份目錄: $SYSTEM_BACKUP_DIR"
                        echo "  原始大小: $(du -h "database/fund_report.db" | cut -f1)"
                        echo "  備份大小: $(sudo du -h "$BACKUP_FILE" | cut -f1)"
                        echo "  注意：備份資料存放在獨立的備份目錄，與系統安裝目錄分開"
                    else
                        echo -e "${RED}❌ 備份驗證失敗：檔案大小不匹配${NC}"
                        echo "  原始大小: $ORIGINAL_SIZE bytes"
                        echo "  備份大小: $BACKUP_SIZE bytes"
                        sudo rm -f "$BACKUP_FILE"
                    fi
                else
                    echo -e "${RED}❌ 無法創建備份目錄${NC}"
                fi
            else
                # 使用本地備份目錄作為備選
                echo -e "${YELLOW}使用本地備份目錄...${NC}"
                BACKUP_DIR="backups"
                mkdir -p "$BACKUP_DIR"
                TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                BACKUP_FILE="$BACKUP_DIR/fund_report_uninstall_${TIMESTAMP}.db"
                cp "database/fund_report.db" "$BACKUP_FILE"
                # 驗證備份檔案
                ORIGINAL_SIZE=$(du -b "database/fund_report.db" 2>/dev/null | cut -f1 || echo "0")
                BACKUP_SIZE=$(du -b "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "0")
                if [ "$BACKUP_SIZE" != "0" ] && [ "$BACKUP_SIZE" = "$ORIGINAL_SIZE" ]; then
                    echo -e "${GREEN}✓ 資料庫已備份至: $BACKUP_FILE${NC}"
                    echo "  原始大小: $(du -h "database/fund_report.db" | cut -f1)"
                    echo "  備份大小: $(du -h "$BACKUP_FILE" | cut -f1)"
                    echo -e "${YELLOW}注意：建議使用 /opt 下的備份目錄以確保資料安全${NC}"
                else
                    echo -e "${RED}❌ 備份驗證失敗：檔案大小不匹配${NC}"
                    echo "  原始大小: $ORIGINAL_SIZE bytes"
                    echo "  備份大小: $BACKUP_SIZE bytes"
                    rm -f "$BACKUP_FILE"
                fi
            fi
        else
            # 有權限，直接備份到 /opt 下的獨立目錄
            mkdir -p "$SYSTEM_BACKUP_DIR"
            if [ $? -eq 0 ]; then
                TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                BACKUP_FILE="$SYSTEM_BACKUP_DIR/fund_report_${TIMESTAMP}.db"
                cp "database/fund_report.db" "$BACKUP_FILE"
                chmod 644 "$BACKUP_FILE"
                # 驗證備份檔案
                ORIGINAL_SIZE=$(du -b "database/fund_report.db" 2>/dev/null | cut -f1 || echo "0")
                BACKUP_SIZE=$(du -b "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "0")
                if [ "$BACKUP_SIZE" != "0" ] && [ "$BACKUP_SIZE" = "$ORIGINAL_SIZE" ]; then
                    echo -e "${GREEN}✓ 資料庫已備份至: $BACKUP_FILE${NC}"
                    echo "  備份目錄: $SYSTEM_BACKUP_DIR"
                    echo "  原始大小: $(du -h "database/fund_report.db" | cut -f1)"
                    echo "  備份大小: $(du -h "$BACKUP_FILE" | cut -f1)"
                    echo "  注意：備份資料存放在獨立的備份目錄，與系統安裝目錄分開"
                else
                    echo -e "${RED}❌ 備份驗證失敗：檔案大小不匹配${NC}"
                    echo "  原始大小: $ORIGINAL_SIZE bytes"
                    echo "  備份大小: $BACKUP_SIZE bytes"
                    rm -f "$BACKUP_FILE"
                fi
            else
                # 備選方案：使用本地備份目錄
                echo -e "${YELLOW}無法寫入 /opt，使用本地備份目錄...${NC}"
                BACKUP_DIR="backups"
                mkdir -p "$BACKUP_DIR"
                TIMESTAMP=$(date +%Y%m%d_%H%M%S)
                BACKUP_FILE="$BACKUP_DIR/fund_report_uninstall_${TIMESTAMP}.db"
                cp "database/fund_report.db" "$BACKUP_FILE"
                # 驗證備份檔案
                ORIGINAL_SIZE=$(du -b "database/fund_report.db" 2>/dev/null | cut -f1 || echo "0")
                BACKUP_SIZE=$(du -b "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "0")
                if [ "$BACKUP_SIZE" != "0" ] && [ "$BACKUP_SIZE" = "$ORIGINAL_SIZE" ]; then
                    echo -e "${GREEN}✓ 資料庫已備份至: $BACKUP_FILE${NC}"
                    echo "  原始大小: $(du -h "database/fund_report.db" | cut -f1)"
                    echo "  備份大小: $(du -h "$BACKUP_FILE" | cut -f1)"
                    echo -e "${YELLOW}注意：建議使用 /opt 下的備份目錄以確保資料安全${NC}"
                else
                    echo -e "${RED}❌ 備份驗證失敗：檔案大小不匹配${NC}"
                    echo "  原始大小: $ORIGINAL_SIZE bytes"
                    echo "  備份大小: $BACKUP_SIZE bytes"
                    rm -f "$BACKUP_FILE"
                fi
            fi
        fi
    fi
fi
echo ""

# 3. 移除 node_modules
echo "3. 移除 node_modules/..."
if [ -d "node_modules" ]; then
    rm -rf node_modules
    echo -e "${GREEN}✓ node_modules/ 已移除${NC}"
else
    echo "node_modules/ 不存在，跳過"
fi
echo ""

# 4. 移除資料庫
echo "4. 移除資料庫檔案..."
read -p "是否要移除資料庫檔案? (y/N): " remove_db
if [[ $remove_db =~ ^[Yy]$ ]]; then
    if [ -f "database/fund_report.db" ]; then
        rm -f database/fund_report.db
        echo -e "${GREEN}✓ 資料庫檔案已移除${NC}"
    else
        echo "資料庫檔案不存在，跳過"
    fi
else
    echo "保留資料庫檔案"
fi
echo ""

# 5. 移除環境配置檔案
echo "5. 移除環境配置檔案..."
read -p "是否要移除 .env 和 .install-config 檔案? (y/N): " remove_env
if [[ $remove_env =~ ^[Yy]$ ]]; then
    if [ -f ".env" ]; then
        rm -f .env
        echo -e "${GREEN}✓ .env 檔案已移除${NC}"
    fi
    if [ -f ".install-config" ]; then
        rm -f .install-config
        echo -e "${GREEN}✓ .install-config 檔案已移除${NC}"
    fi
else
    echo "保留配置檔案"
fi
echo ""

# 6. 移除其他暫存檔案
echo "6. 清理暫存檔案..."
rm -f npm-debug.log yarn-error.log 2>/dev/null || true
rm -rf .DS_Store 2>/dev/null || true
echo -e "${GREEN}✓ 暫存檔案已清理${NC}"
echo ""

# 7. 如果是部署在 /opt，詢問是否移除整個目錄
if [[ "$CURRENT_DIR" == /opt/* ]]; then
    echo "7. 部署目錄選項..."
    read -p "是否要移除整個部署目錄 $CURRENT_DIR? (y/N): " remove_dir
    if [[ $remove_dir =~ ^[Yy]$ ]]; then
        if [ "$EUID" -eq 0 ]; then
            PARENT_DIR=$(dirname "$CURRENT_DIR")
            DIR_NAME=$(basename "$CURRENT_DIR")
            cd "$PARENT_DIR"
            rm -rf "$DIR_NAME"
            echo -e "${GREEN}✓ 部署目錄已移除${NC}"
        else
            echo -e "${YELLOW}需要 root 權限才能移除 /opt 目錄${NC}"
            echo "請手動執行: sudo rm -rf $CURRENT_DIR"
        fi
    else
        echo "保留部署目錄"
    fi
    echo ""
fi

echo "========================================="
echo -e "${GREEN}  移除完成！${NC}"
echo "========================================="
echo ""
echo "注意事項："
echo "  - package.json 和其他原始碼檔案已保留（除非選擇移除整個目錄）"
echo "  - 如需完全移除，請手動刪除專案目錄"
echo ""
echo "如需重新安裝，請執行："
echo "  ${YELLOW}./install.sh${NC}"
echo ""

echo ""
