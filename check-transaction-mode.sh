#!/bin/bash
# 檢查收支模式配置

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================="
echo "  收支模式配置檢查"
echo "========================================="
echo ""

# 1. 檢查 .env 檔案
echo -e "${BLUE}1. .env 檔案檢查${NC}"
if [ -f ".env" ]; then
    echo -e "   ${GREEN}✓ .env 檔案存在${NC}"
    
    TRANSACTION_MODE=$(grep "^TRANSACTION_MODE=" .env 2>/dev/null | cut -d'=' -f2)
    if [ ! -z "$TRANSACTION_MODE" ]; then
        echo "   TRANSACTION_MODE=$TRANSACTION_MODE"
        if [ "$TRANSACTION_MODE" = "expense_only" ]; then
            echo -e "   ${GREEN}✓ 配置為「僅支出」模式${NC}"
        elif [ "$TRANSACTION_MODE" = "full" ]; then
            echo -e "   ${YELLOW}⚠ 配置為「完整功能」模式${NC}"
        else
            echo -e "   ${RED}✗ 配置值無效: $TRANSACTION_MODE${NC}"
        fi
    else
        echo -e "   ${RED}✗ 找不到 TRANSACTION_MODE 配置${NC}"
    fi
else
    echo -e "   ${RED}✗ .env 檔案不存在${NC}"
fi
echo ""

# 2. 檢查服務狀態
echo -e "${BLUE}2. 服務狀態檢查${NC}"
SERVICE_NAME=$(ls /etc/systemd/system/*.service 2>/dev/null | grep -E "(fund|wfr)" | head -1 | xargs basename 2>/dev/null)
if [ ! -z "$SERVICE_NAME" ]; then
    echo "   服務名稱: $SERVICE_NAME"
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo -e "   ${GREEN}✓ 服務運行中${NC}"
        
        # 檢查服務最後重啟時間
        RESTART_TIME=$(systemctl show "$SERVICE_NAME" -p ActiveEnterTimestamp --value 2>/dev/null)
        if [ ! -z "$RESTART_TIME" ]; then
            echo "   最後啟動: $RESTART_TIME"
        fi
        
        # 檢查 .env 最後修改時間
        if [ -f ".env" ]; then
            ENV_MTIME=$(stat -c %y .env 2>/dev/null || stat -f "%Sm" .env 2>/dev/null)
            echo "   .env 修改: $ENV_MTIME"
        fi
    else
        echo -e "   ${YELLOW}⚠ 服務未運行${NC}"
    fi
else
    echo -e "   ${YELLOW}⚠ 未找到 systemd 服務${NC}"
fi
echo ""

# 3. 測試 API 端點
echo -e "${BLUE}3. API 配置檢查${NC}"
PORT=$(grep "^PORT=" .env 2>/dev/null | cut -d'=' -f2)
PORT=${PORT:-3000}

if command -v curl &> /dev/null; then
    echo "   測試 API: http://localhost:$PORT/api/config"
    
    API_RESPONSE=$(curl -s "http://localhost:$PORT/api/config" 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo "   API 響應:"
        echo "$API_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$API_RESPONSE"
        
        # 提取 transaction_mode
        if echo "$API_RESPONSE" | grep -q "transaction_mode"; then
            MODE=$(echo "$API_RESPONSE" | grep -o '"transaction_mode":"[^"]*"' | cut -d'"' -f4)
            if [ "$MODE" = "expense_only" ]; then
                echo -e "   ${GREEN}✓ API 返回「僅支出」模式${NC}"
            elif [ "$MODE" = "full" ]; then
                echo -e "   ${YELLOW}⚠ API 返回「完整功能」模式${NC}"
            fi
        else
            echo -e "   ${RED}✗ API 響應中沒有 transaction_mode${NC}"
        fi
    else
        echo -e "   ${RED}✗ 無法連接到 API${NC}"
    fi
else
    echo -e "   ${YELLOW}⚠ curl 未安裝，無法測試 API${NC}"
fi
echo ""

# 4. 檢查前端檔案
echo -e "${BLUE}4. 前端檔案檢查${NC}"
if [ -f "public/transactions.html" ]; then
    echo -e "   ${GREEN}✓ transactions.html 存在${NC}"
    
    # 檢查是否有 loadConfig 函數
    if grep -q "transaction_mode" public/transactions.html; then
        echo -e "   ${GREEN}✓ 包含 transaction_mode 處理邏輯${NC}"
    else
        echo -e "   ${RED}✗ 缺少 transaction_mode 處理邏輯${NC}"
    fi
    
    # 檢查檔案修改時間
    HTML_MTIME=$(stat -c %y public/transactions.html 2>/dev/null || stat -f "%Sm" public/transactions.html 2>/dev/null)
    echo "   檔案修改: $HTML_MTIME"
else
    echo -e "   ${RED}✗ transactions.html 不存在${NC}"
fi
echo ""

# 5. 總結和建議
echo "========================================="
echo -e "${BLUE}  診斷結果與建議${NC}"
echo "========================================="
echo ""

if [ "$TRANSACTION_MODE" = "expense_only" ]; then
    echo -e "${GREEN}✓ 配置正確設定為「僅支出」模式${NC}"
    echo ""
    echo "如果前端仍顯示收入功能，請嘗試："
    echo ""
    echo "1. 重啟服務（確保載入新配置）："
    echo "   ${YELLOW}systemctl restart $SERVICE_NAME${NC}"
    echo ""
    echo "2. 清除瀏覽器快取："
    echo "   ${YELLOW}Chrome/Edge: Ctrl + Shift + Delete${NC}"
    echo "   ${YELLOW}Firefox: Ctrl + Shift + Delete${NC}"
    echo "   或使用無痕/隱私模式測試"
    echo ""
    echo "3. 強制重新載入頁面："
    echo "   ${YELLOW}Ctrl + F5 (Windows)${NC}"
    echo "   ${YELLOW}Cmd + Shift + R (Mac)${NC}"
    echo ""
    echo "4. 檢查瀏覽器控制台："
    echo "   按 F12 開啟開發者工具"
    echo "   查看 Console 是否有錯誤訊息"
    echo "   查看 Network 標籤，確認 /api/config 請求"
    echo ""
else
    echo -e "${YELLOW}⚠ 配置未設定為「僅支出」模式${NC}"
    echo ""
    echo "請修正配置："
    echo ""
    echo "1. 編輯 .env 檔案："
    echo "   ${YELLOW}nano .env${NC}"
    echo ""
    echo "2. 確保包含以下行："
    echo "   ${YELLOW}TRANSACTION_MODE=expense_only${NC}"
    echo ""
    echo "3. 儲存後重啟服務："
    echo "   ${YELLOW}systemctl restart $SERVICE_NAME${NC}"
    echo ""
fi
