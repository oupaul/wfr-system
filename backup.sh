#!/bin/bash
# 資金週報系統 - 資料庫備份腳本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 自動修復當前腳本的換行符問題（Windows CRLF -> Linux LF）
if command -v sed &> /dev/null; then
    sed -i 's/\r$//' "$0" 2>/dev/null || true
fi
if command -v dos2unix &> /dev/null; then
    dos2unix "$0" 2>/dev/null || true
fi

# 載入安裝配置
DEPLOY_PATH="$SCRIPT_DIR"
BACKUP_DIR=""
if [ -f ".install-config" ]; then
    CONFIG_DEPLOY_PATH=$(grep "^DEPLOY_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    CONFIG_BACKUP_PATH=$(grep "^BACKUP_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    if [ -n "$CONFIG_DEPLOY_PATH" ] && [ "$CONFIG_DEPLOY_PATH" != "$SCRIPT_DIR" ]; then
        echo "偵測到配置的部署路徑: $CONFIG_DEPLOY_PATH"
        read -p "是否要從配置的部署路徑備份? (Y/n): " use_config_path
        if [[ ! $use_config_path =~ ^[Nn]$ ]]; then
            DEPLOY_PATH="$CONFIG_DEPLOY_PATH"
            cd "$DEPLOY_PATH"
        fi
    fi
    if [ -n "$CONFIG_BACKUP_PATH" ]; then
        BACKUP_DIR="$CONFIG_BACKUP_PATH"
    fi
fi
if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="backups"
fi

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DB_PATH="database/fund_report.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/fund_report_$TIMESTAMP.db"

CURRENT_DIR=$(pwd)
echo "========================================="
echo "  資金週報系統 - 資料庫備份"
echo "========================================="
echo ""
echo "當前目錄: $CURRENT_DIR"
echo ""

# 檢查資料庫是否存在
if [ ! -f "$DB_PATH" ]; then
    echo -e "${RED}❌ 找不到資料庫檔案: $DB_PATH${NC}"
    echo "請確認："
    echo "  1. 當前目錄是否正確"
    echo "  2. 資料庫檔案是否存在"
    exit 1
fi

# 建立備份目錄
mkdir -p "$BACKUP_DIR"

# 檢查備份目錄權限
if [ ! -w "$BACKUP_DIR" ]; then
    echo -e "${RED}❌ 備份目錄沒有寫入權限: $BACKUP_DIR${NC}"
    exit 1
fi

# 取得資料庫檔案大小
DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
echo "資料庫檔案: $DB_PATH"
echo "資料庫大小: $DB_SIZE"
echo "備份目標: $BACKUP_FILE"
echo ""

# 執行備份
echo "正在備份資料庫..."
cp "$DB_PATH" "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo ""
    echo "========================================="
    echo -e "${GREEN}  備份成功！${NC}"
    echo "========================================="
    echo ""
    echo "備份檔案: $BACKUP_FILE"
    echo "備份大小: $BACKUP_SIZE"
    echo "備份路徑: $CURRENT_DIR/$BACKUP_FILE"
    echo ""
    
    # 列出最近的備份
    if [ -d "$BACKUP_DIR" ] && [ "$(ls -A $BACKUP_DIR/fund_report_*.db 2>/dev/null)" ]; then
        echo "最近的備份檔案："
        ls -lh "$BACKUP_DIR"/fund_report_*.db 2>/dev/null | tail -5 | awk '{print "  - " $9 " (" $5 ")"}'
        
        # 備份數量統計
        BACKUP_COUNT=$(ls -1 "$BACKUP_DIR"/fund_report_*.db 2>/dev/null | wc -l)
        echo ""
        echo "總備份數量: $BACKUP_COUNT"
        
        # 清理舊備份（保留最近 30 個）
        if [ "$BACKUP_COUNT" -gt 30 ]; then
            echo ""
            echo -e "${YELLOW}備份數量超過 30 個，清理舊備份...${NC}"
            ls -t "$BACKUP_DIR"/fund_report_*.db | tail -n +31 | xargs rm -f
            echo -e "${GREEN}✓ 已清理舊備份${NC}"
        fi
    fi
else
    echo -e "${RED}❌ 備份失敗${NC}"
    exit 1
fi

echo ""