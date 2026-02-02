#!/bin/bash
# 資金週報系統 - 資料庫還原腳本

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
CONFIG_BACKUP_PATH=""
if [ -f ".install-config" ]; then
    CONFIG_DEPLOY_PATH=$(grep "^DEPLOY_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    CONFIG_BACKUP_PATH=$(grep "^BACKUP_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    if [ -n "$CONFIG_DEPLOY_PATH" ] && [ "$CONFIG_DEPLOY_PATH" != "$SCRIPT_DIR" ]; then
        echo "偵測到配置的部署路徑: $CONFIG_DEPLOY_PATH"
        read -p "是否要還原到配置的部署路徑? (Y/n): " use_config_path
        if [[ ! $use_config_path =~ ^[Nn]$ ]]; then
            DEPLOY_PATH="$CONFIG_DEPLOY_PATH"
            cd "$DEPLOY_PATH"
        fi
    fi
fi

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DB_PATH="database/fund_report.db"
# 備份目錄：優先使用 .install-config 的 BACKUP_PATH，否則預設 /opt 下目錄與應用下 backups
SYSTEM_BACKUP_DIR="${CONFIG_BACKUP_PATH:-/opt/fund-weekly-report-backups}"
LOCAL_BACKUP_DIR="backups"

CURRENT_DIR=$(pwd)
echo "========================================="
echo "  資金週報系統 - 資料庫還原"
echo "========================================="
echo ""
echo "當前目錄: $CURRENT_DIR"
echo ""

# 檢查兩個備份目錄
SYSTEM_BACKUP_EXISTS=false
LOCAL_BACKUP_EXISTS=false

if [ -d "$SYSTEM_BACKUP_DIR" ] && [ -r "$SYSTEM_BACKUP_DIR" ]; then
    SYSTEM_BACKUP_EXISTS=true
fi

if [ -d "$LOCAL_BACKUP_DIR" ]; then
    LOCAL_BACKUP_EXISTS=true
fi

# 如果兩個目錄都不存在
if [ "$SYSTEM_BACKUP_EXISTS" = false ] && [ "$LOCAL_BACKUP_EXISTS" = false ]; then
    echo -e "${RED}❌ 找不到備份目錄${NC}"
    echo "  系統備份目錄: $SYSTEM_BACKUP_DIR"
    echo "  本地備份目錄: $CURRENT_DIR/$LOCAL_BACKUP_DIR"
    exit 1
fi

# 收集所有備份檔案並按時間排序（最新的在前）
# 使用臨時檔案來收集和排序
TEMP_SORTED=$(mktemp)
trap "rm -f $TEMP_SORTED" EXIT

# 收集系統備份目錄的檔案（帶時間戳）
if [ "$SYSTEM_BACKUP_EXISTS" = true ]; then
    shopt -s nullglob  # 如果沒有匹配，返回空而不是字面值
    for file in "$SYSTEM_BACKUP_DIR"/fund_report_*.db; do
        if [ -f "$file" ] && [ -r "$file" ]; then
            if stat -c %Y "$file" &>/dev/null 2>&1; then
                timestamp=$(stat -c %Y "$file" 2>/dev/null)
            elif stat -f %m "$file" &>/dev/null 2>&1; then
                timestamp=$(stat -f %m "$file" 2>/dev/null)
            else
                timestamp=0
            fi
            echo "$timestamp|system|$file" >> "$TEMP_SORTED"
        fi
    done
    shopt -u nullglob
fi

# 收集本地備份目錄的檔案（帶時間戳）
if [ "$LOCAL_BACKUP_EXISTS" = true ]; then
    shopt -s nullglob
    for file in "$LOCAL_BACKUP_DIR"/fund_report_*.db; do
        if [ -f "$file" ] && [ -r "$file" ]; then
            if stat -c %Y "$file" &>/dev/null 2>&1; then
                timestamp=$(stat -c %Y "$file" 2>/dev/null)
            elif stat -f %m "$file" &>/dev/null 2>&1; then
                timestamp=$(stat -f %m "$file" 2>/dev/null)
            else
                timestamp=0
            fi
            echo "$timestamp|local|$file" >> "$TEMP_SORTED"
        fi
    done
    shopt -u nullglob
fi

# 按時間戳排序（降序，最新的在前）並讀入陣列
BACKUP_FILES=()
BACKUP_SOURCES=()
if [ -s "$TEMP_SORTED" ]; then
    # 排序後，讀取所有三個欄位：timestamp|source|filepath
    # 然後只使用 source 和 filepath
    while IFS='|' read -r timestamp source filepath; do
        if [ -n "$filepath" ] && [ -n "$source" ] && [ -f "$filepath" ]; then
            BACKUP_FILES+=("$filepath")
            BACKUP_SOURCES+=("$source")
        fi
    done < <(sort -rn -t'|' -k1 "$TEMP_SORTED")
fi

if [ ${#BACKUP_FILES[@]} -eq 0 ]; then
    echo -e "${RED}❌ 找不到備份檔案${NC}"
    if [ "$SYSTEM_BACKUP_EXISTS" = true ]; then
        echo "  系統備份目錄: $SYSTEM_BACKUP_DIR"
    fi
    if [ "$LOCAL_BACKUP_EXISTS" = true ]; then
        echo "  本地備份目錄: $CURRENT_DIR/$LOCAL_BACKUP_DIR"
    fi
    exit 1
fi

echo "可用的備份檔案："
echo ""
for i in "${!BACKUP_FILES[@]}"; do
    BACKUP_FILE="${BACKUP_FILES[$i]}"
    if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
        continue  # 跳過無效的檔案
    fi
    FILE_NAME=$(basename "$BACKUP_FILE")
    FILE_SIZE=$(du -h "$BACKUP_FILE" 2>/dev/null | cut -f1 || echo "未知")
    FILE_DATE=$(stat -c %y "$BACKUP_FILE" 2>/dev/null || stat -f %Sm "$BACKUP_FILE" 2>/dev/null || echo "未知")
    SOURCE_TYPE="${BACKUP_SOURCES[$i]}"
    if [ "$SOURCE_TYPE" = "system" ]; then
        SOURCE_LABEL="系統備份 ($SYSTEM_BACKUP_DIR)"
    else
        SOURCE_LABEL="本地備份 ($LOCAL_BACKUP_DIR)"
    fi
    echo "  [$((i+1))] $FILE_NAME"
    echo "      來源: $SOURCE_LABEL"
    echo "      大小: $FILE_SIZE"
    echo "      日期: $FILE_DATE"
    echo ""
done

# 讓用戶選擇備份檔案
if [ -z "$1" ]; then
    read -p "請選擇要還原的備份檔案編號 (1-${#BACKUP_FILES[@]}): " choice
else
    choice=$1
fi

if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt ${#BACKUP_FILES[@]} ]; then
    echo -e "${RED}❌ 無效的選擇${NC}"
    exit 1
fi

SELECTED_BACKUP="${BACKUP_FILES[$((choice-1))]}"

# 驗證選定的備份檔案
if [ -z "$SELECTED_BACKUP" ] || [ ! -f "$SELECTED_BACKUP" ]; then
    echo -e "${RED}❌ 無效的備份檔案路徑${NC}"
    exit 1
fi

# 檢查備份檔案是否可讀
if [ ! -r "$SELECTED_BACKUP" ]; then
    echo -e "${YELLOW}備份檔案需要特殊權限，嘗試使用 sudo 讀取...${NC}"
    if sudo test -r "$SELECTED_BACKUP"; then
        USE_SUDO_READ=true
    else
        echo -e "${RED}❌ 無法讀取備份檔案${NC}"
        exit 1
    fi
else
    USE_SUDO_READ=false
fi

BACKUP_FILE_NAME=$(basename "$SELECTED_BACKUP")

# 獲取備份檔案大小（字節）
if [ "$USE_SUDO_READ" = true ]; then
    BACKUP_SIZE_BYTES=$(sudo du -b "$SELECTED_BACKUP" 2>/dev/null | cut -f1 || echo "0")
    BACKUP_SIZE=$(sudo du -h "$SELECTED_BACKUP" 2>/dev/null | cut -f1 || echo "未知")
else
    BACKUP_SIZE_BYTES=$(du -b "$SELECTED_BACKUP" 2>/dev/null | cut -f1 || echo "0")
    BACKUP_SIZE=$(du -h "$SELECTED_BACKUP" 2>/dev/null | cut -f1 || echo "未知")
fi

# 驗證備份檔案大小（不應該為0或空）
if [ "$BACKUP_SIZE_BYTES" = "0" ] || [ -z "$BACKUP_SIZE_BYTES" ]; then
    echo -e "${RED}❌ 警告：備份檔案大小為 0，可能損壞或為空檔案${NC}"
    read -p "是否仍要繼續還原? (yes/NO): " continue_anyway
    if [ "$continue_anyway" != "yes" ]; then
        echo "取消還原操作"
        exit 0
    fi
fi

echo ""
echo "選定的備份檔案: $BACKUP_FILE_NAME"
echo "完整路徑: $SELECTED_BACKUP"
echo "備份大小: $BACKUP_SIZE ($BACKUP_SIZE_BYTES bytes)"
echo "還原目標: $CURRENT_DIR/$DB_PATH"
echo ""

# 警告：如果資料庫已存在，先備份
if [ -f "$DB_PATH" ]; then
    echo -e "${YELLOW}⚠️  警告：目標資料庫檔案已存在${NC}"
    read -p "是否要先備份現有資料庫? (Y/n): " backup_existing
    
    if [[ ! $backup_existing =~ ^[Nn]$ ]]; then
        echo "正在備份現有資料庫..."
        # 優先使用系統備份目錄，如果沒有權限則使用本地目錄
        if [ -w "$SYSTEM_BACKUP_DIR" ] || ([ "$EUID" -eq 0 ] && [ -d "$SYSTEM_BACKUP_DIR" ]); then
            if [ "$EUID" -ne 0 ] && [ ! -w "$SYSTEM_BACKUP_DIR" ]; then
                # 需要 sudo 權限
                read -p "需要 root 權限備份到系統目錄，是否使用 sudo? (Y/n): " use_sudo
                if [[ ! $use_sudo =~ ^[Nn]$ ]]; then
                    sudo mkdir -p "$SYSTEM_BACKUP_DIR"
                    EXISTING_BACKUP="$SYSTEM_BACKUP_DIR/fund_report_pre_restore_$(date +%Y%m%d_%H%M%S).db"
                    sudo cp "$DB_PATH" "$EXISTING_BACKUP"
                    sudo chmod 644 "$EXISTING_BACKUP"
                    echo -e "${GREEN}✓ 現有資料庫已備份至: $EXISTING_BACKUP${NC}"
                else
                    mkdir -p "$LOCAL_BACKUP_DIR"
                    EXISTING_BACKUP="$LOCAL_BACKUP_DIR/fund_report_pre_restore_$(date +%Y%m%d_%H%M%S).db"
                    cp "$DB_PATH" "$EXISTING_BACKUP"
                    echo -e "${GREEN}✓ 現有資料庫已備份至: $EXISTING_BACKUP${NC}"
                fi
            else
                mkdir -p "$SYSTEM_BACKUP_DIR"
                EXISTING_BACKUP="$SYSTEM_BACKUP_DIR/fund_report_pre_restore_$(date +%Y%m%d_%H%M%S).db"
                cp "$DB_PATH" "$EXISTING_BACKUP"
                chmod 644 "$EXISTING_BACKUP"
                echo -e "${GREEN}✓ 現有資料庫已備份至: $EXISTING_BACKUP${NC}"
            fi
        else
            mkdir -p "$LOCAL_BACKUP_DIR"
            EXISTING_BACKUP="$LOCAL_BACKUP_DIR/fund_report_pre_restore_$(date +%Y%m%d_%H%M%S).db"
            cp "$DB_PATH" "$EXISTING_BACKUP"
            echo -e "${GREEN}✓ 現有資料庫已備份至: $EXISTING_BACKUP${NC}"
        fi
        echo ""
    fi
fi

# 確認還原
read -p "確定要還原此備份嗎? (yes/NO): " confirm
if [ "$confirm" != "yes" ]; then
    echo "取消還原操作"
    exit 0
fi

# 確保資料庫目錄存在
mkdir -p "$(dirname "$DB_PATH")"

# 執行還原
echo ""
echo "正在還原資料庫..."

# 根據權限決定使用 cp 還是 sudo cp
if [ "$USE_SUDO_READ" = true ]; then
    sudo cp "$SELECTED_BACKUP" "$DB_PATH"
    RESTORE_RESULT=$?
    if [ $RESTORE_RESULT -eq 0 ]; then
        sudo chmod 644 "$DB_PATH" 2>/dev/null || chmod 644 "$DB_PATH" 2>/dev/null || true
    fi
else
    cp "$SELECTED_BACKUP" "$DB_PATH"
    RESTORE_RESULT=$?
fi

if [ $RESTORE_RESULT -eq 0 ]; then
    # 驗證還原後的檔案大小
    RESTORED_SIZE_BYTES=$(du -b "$DB_PATH" 2>/dev/null | cut -f1 || echo "0")
    RESTORED_SIZE=$(du -h "$DB_PATH" 2>/dev/null | cut -f1 || echo "未知")
    
    # 比較備份和還原後的檔案大小
    if [ "$RESTORED_SIZE_BYTES" = "$BACKUP_SIZE_BYTES" ] && [ "$RESTORED_SIZE_BYTES" != "0" ]; then
        echo ""
        echo "========================================="
        echo -e "${GREEN}  還原成功！${NC}"
        echo "========================================="
        echo ""
        echo "資料庫檔案: $DB_PATH"
        echo "資料庫大小: $RESTORED_SIZE ($RESTORED_SIZE_BYTES bytes)"
        echo "備份大小: $BACKUP_SIZE ($BACKUP_SIZE_BYTES bytes)"
        echo "還原自: $BACKUP_FILE_NAME"
        echo "還原路徑: $CURRENT_DIR/$DB_PATH"
        echo ""
        echo -e "${GREEN}✓ 檔案大小驗證通過${NC}"
        echo "提示: 建議重新啟動伺服器以確保資料正確載入"
    else
        echo ""
        echo "========================================="
        echo -e "${YELLOW}  ⚠️  還原完成，但檔案大小驗證失敗${NC}"
        echo "========================================="
        echo ""
        echo "資料庫檔案: $DB_PATH"
        echo "還原後大小: $RESTORED_SIZE ($RESTORED_SIZE_BYTES bytes)"
        echo "備份大小: $BACKUP_SIZE ($BACKUP_SIZE_BYTES bytes)"
        echo "還原自: $BACKUP_FILE_NAME"
        echo ""
        echo -e "${YELLOW}警告：檔案大小不匹配，請檢查資料是否完整${NC}"
        echo "提示: 建議重新啟動伺服器並檢查資料"
    fi
else
    echo -e "${RED}❌ 還原失敗${NC}"
    exit 1
fi

echo ""