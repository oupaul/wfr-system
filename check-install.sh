#!/bin/bash
# 資金週報系統 - 安裝狀態檢查腳本

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "  資金週報系統 - 安裝狀態檢查"
echo "========================================="
echo ""

# 1. 檢查當前目錄
echo -e "${BLUE}1. 當前目錄檢查${NC}"
CURRENT_DIR=$(pwd)
echo "   當前目錄: $CURRENT_DIR"

if [ -f "package.json" ] && [ -f "server.js" ]; then
    echo -e "   ${GREEN}✓ 發現系統檔案${NC}"
else
    echo -e "   ${RED}✗ 找不到系統檔案${NC}"
fi
echo ""

# 2. 檢查 /opt 下的安裝
echo -e "${BLUE}2. /opt 目錄檢查${NC}"
if [ -d "/opt" ]; then
    FOUND_INSTALLS=()
    for dir in /opt/*/; do
        if [ -d "$dir" ] && [ -f "$dir/package.json" ] && [ -f "$dir/server.js" ]; then
            FOUND_INSTALLS+=("$dir")
        fi
    done
    
    if [ ${#FOUND_INSTALLS[@]} -gt 0 ]; then
        echo "   找到以下安裝："
        for install_dir in "${FOUND_INSTALLS[@]}"; do
            echo -e "   ${GREEN}✓ $install_dir${NC}"
        done
    else
        echo -e "   ${YELLOW}⚠ 未在 /opt 下找到安裝${NC}"
    fi
else
    echo -e "   ${YELLOW}⚠ /opt 目錄不存在${NC}"
fi
echo ""

# 3. 檢查配置檔案
echo -e "${BLUE}3. 配置檔案檢查${NC}"
if [ -f ".install-config" ]; then
    echo -e "   ${GREEN}✓ 找到 .install-config${NC}"
    echo "   配置內容："
    cat .install-config | while IFS= read -r line; do
        echo "     $line"
    done
else
    echo -e "   ${YELLOW}⚠ 找不到 .install-config${NC}"
fi
echo ""

# 4. 檢查 systemd 服務
echo -e "${BLUE}4. systemd 服務檢查${NC}"
SERVICE_FILES=$(find /etc/systemd/system/ -name "*fund*" -o -name "*wfr*" 2>/dev/null)
if [ ! -z "$SERVICE_FILES" ]; then
    echo "   找到以下服務檔案："
    echo "$SERVICE_FILES" | while IFS= read -r file; do
        echo -e "   ${GREEN}✓ $file${NC}"
        SERVICE_NAME=$(basename "$file")
        
        # 顯示服務狀態
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            echo -e "     狀態: ${GREEN}運行中${NC}"
        else
            echo -e "     狀態: ${YELLOW}未運行${NC}"
        fi
        
        # 顯示 WorkingDirectory
        WORK_DIR=$(grep "WorkingDirectory=" "$file" 2>/dev/null | cut -d'=' -f2)
        if [ ! -z "$WORK_DIR" ]; then
            echo "     工作目錄: $WORK_DIR"
            if [ -d "$WORK_DIR" ]; then
                echo -e "     ${GREEN}✓ 目錄存在${NC}"
            else
                echo -e "     ${RED}✗ 目錄不存在！${NC}"
            fi
        fi
        echo ""
    done
else
    echo -e "   ${YELLOW}⚠ 未找到相關的 systemd 服務${NC}"
fi
echo ""

# 5. 檢查執行中的進程
echo -e "${BLUE}5. 執行中進程檢查${NC}"
NODE_PROCESSES=$(ps aux | grep "[n]ode.*server.js" || true)
if [ ! -z "$NODE_PROCESSES" ]; then
    echo "   找到以下 Node.js 進程："
    echo "$NODE_PROCESSES" | while IFS= read -r line; do
        PID=$(echo "$line" | awk '{print $2}')
        WORK_DIR=$(pwdx "$PID" 2>/dev/null | awk '{print $2}')
        echo -e "   ${GREEN}✓ PID: $PID${NC}"
        if [ ! -z "$WORK_DIR" ]; then
            echo "     工作目錄: $WORK_DIR"
        fi
    done
else
    echo -e "   ${YELLOW}⚠ 未找到運行中的 Node.js 進程${NC}"
fi
echo ""

# 6. 總結
echo "========================================="
echo -e "${BLUE}  檢查完成${NC}"
echo "========================================="
echo ""
echo "如果發現部署位置不正確，請："
echo "1. 停止當前服務: sudo systemctl stop <服務名稱>"
echo "2. 移除舊安裝: sudo ./uninstall.sh"
echo "3. 重新執行安裝: sudo ./install.sh"
echo "   並在第一步選擇 [2] 部署到 /opt"
echo ""
