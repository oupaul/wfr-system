#!/bin/bash
# 資金週報系統 - 一鍵更新腳本
# 用途：從 GitHub 拉取最新程式碼、安裝相依套件、重啟服務

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

# 整段邏輯包在 main() 裡再呼叫：避免上面 sed -i 修改腳本檔案本身時，
# bash 仍在執行舊版分段緩衝的內容（曾在其他專案的自更新腳本上踩過這個雷）。
main() {

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "========================================="
echo "  資金週報系統 - 一鍵更新"
echo "========================================="
echo ""

# 1. 確認部署目錄
DEPLOY_PATH="$SCRIPT_DIR"
if [ -f ".install-config" ]; then
    CONFIG_DEPLOY_PATH=$(grep "^DEPLOY_PATH=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    if [ -n "$CONFIG_DEPLOY_PATH" ] && [ "$CONFIG_DEPLOY_PATH" != "$SCRIPT_DIR" ] && [ -d "$CONFIG_DEPLOY_PATH" ]; then
        echo "偵測到配置的部署路徑: $CONFIG_DEPLOY_PATH"
        read -p "是否改用此路徑進行更新? (Y/n): " use_config_path
        if [[ ! $use_config_path =~ ^[Nn]$ ]]; then
            DEPLOY_PATH="$CONFIG_DEPLOY_PATH"
        fi
    fi
fi
cd "$DEPLOY_PATH"
CURRENT_DIR=$(pwd)
echo "部署目錄: $CURRENT_DIR"
echo ""

# 避免以不同使用者執行本腳本（例如直接用 root 執行，但檔案是用其他帳號部署的）
# 時，git 2.35+ 的「detected dubious ownership」保護機制擋下所有 git 指令
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$CURRENT_DIR"; then
    git config --global --add safe.directory "$CURRENT_DIR"
fi

if [ ! -d ".git" ]; then
    echo -e "${RED}❌ 此目錄不是 git repository，無法自動更新${NC}"
    echo ""
    echo "舊版 install.sh 部署到 /opt 時會把 .git 排除掉，導致部署目錄"
    echo "和原本 git clone 的來源目錄分家——這就是「git pull 好像有拉，"
    echo "但服務沒有真的更新」的原因。一次性修正（不會動到 database/、"
    echo ".env）："
    echo ""
    echo "  cd $CURRENT_DIR"
    echo "  git init"
    echo "  git remote add origin https://github.com/oupaul/wfr-system.git"
    echo "  git fetch origin main"
    echo "  git checkout -f -b main origin/main"
    echo ""
    echo "改完之後這個目錄本身就是完整 git repo，之後直接在這裡執行"
    echo "./update.sh 即可。"
    exit 1
fi

# 2. 找出實際對應的 systemd 服務名稱（服務名稱安裝時可能被自訂，例如 cashflow-prod）
SERVICE_NAME=""
SERVICE_USER=""
if [ -d "/etc/systemd/system" ]; then
    for svc_file in /etc/systemd/system/*.service; do
        [ -f "$svc_file" ] || continue
        if grep -q "^WorkingDirectory=${CURRENT_DIR}$" "$svc_file" 2>/dev/null; then
            SERVICE_NAME=$(basename "$svc_file" .service)
            SERVICE_USER=$(grep "^User=" "$svc_file" 2>/dev/null | head -1 | cut -d'=' -f2-)
            break
        fi
    done
fi
if [ -z "$SERVICE_NAME" ] && [ -f ".install-config" ]; then
    SERVICE_NAME=$(grep "^SERVICE_NAME=" .install-config 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
fi
SERVICE_NAME=${SERVICE_NAME:-fund-weekly-report}

HAS_SERVICE=false
if systemctl list-unit-files 2>/dev/null | grep -q "${SERVICE_NAME}.service"; then
    HAS_SERVICE=true
    echo "偵測到 systemd 服務: ${SERVICE_NAME}.service"
else
    echo -e "${YELLOW}⚠ 找不到對應的 systemd 服務，更新後需自行重啟伺服器${NC}"
fi
echo ""

# 3. 檢查未提交的本地變更（例如先前手動 chmod 或改過檔案），避免 git pull 直接失敗或覆蓋
git config core.fileMode false 2>/dev/null || true

if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}⚠ 偵測到未提交的本地變更：${NC}"
    git status --short
    echo ""
    read -p "是否要暫存 (stash) 這些變更後繼續更新? (Y/n): " stash_choice
    if [[ ! $stash_choice =~ ^[Nn]$ ]]; then
        git stash push -u -m "update.sh 自動暫存 $(date +%Y%m%d_%H%M%S)"
        STASHED=true
        echo -e "${GREEN}✓ 已暫存本地變更（可用 'git stash list' 查看，'git stash pop' 還原）${NC}"
    else
        echo -e "${RED}❌ 取消更新：請先手動處理本地變更（commit 或 git checkout -- .）${NC}"
        exit 1
    fi
fi
echo ""

# 4. 更新前備份資料庫（快速、非互動，避免更新出問題時沒有退路）
if [ -f "database/fund_report.db" ]; then
    echo "4. 更新前備份資料庫..."
    mkdir -p backups
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    cp "database/fund_report.db" "backups/fund_report_pre-update_${TIMESTAMP}.db"
    echo -e "${GREEN}✓ 已備份至 backups/fund_report_pre-update_${TIMESTAMP}.db${NC}"
    echo ""
fi

# 5. 拉取最新程式碼
echo "5. 拉取最新程式碼..."
BEFORE_COMMIT=$(git rev-parse HEAD)
git pull
AFTER_COMMIT=$(git rev-parse HEAD)

if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
    echo -e "${GREEN}✓ 已是最新版本，無需更新${NC}"
    echo ""
else
    echo -e "${GREEN}✓ 已更新: ${BEFORE_COMMIT:0:7} → ${AFTER_COMMIT:0:7}${NC}"
    echo ""
    echo "本次更新內容："
    git log --oneline "${BEFORE_COMMIT}..${AFTER_COMMIT}"
    echo ""
fi

# 6. 安裝/更新相依套件（package.json 有變更才需要，但每次跑一次成本很低）
echo "6. 檢查相依套件..."
if [ -f "package.json" ]; then
    npm install --production 2>&1 | tail -5
    echo -e "${GREEN}✓ 相依套件已更新${NC}"
fi
echo ""

# 若以 root 執行本腳本，上面的 git pull / npm install 會把新增/修改的檔案變成
# root 所有，但服務實際上是用 systemd 設定的 User= 帳號在跑——這正是先前正式
# 環境發生過的問題（root 擁有的 fund_report.db 讓以 itadmin 執行的服務寫入失敗、
# 502 crash loop）。重啟服務前先把目錄擁有者改回服務帳號，避免重蹈覆轍。
if [ "$EUID" -eq 0 ] && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != "root" ]; then
    echo "修正檔案擁有者為 ${SERVICE_USER}（避免服務因權限不足而寫入失敗）..."
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$CURRENT_DIR"
    echo -e "${GREEN}✓ 已修正${NC}"
    echo ""
fi

# 7. 重啟服務
if [ "$HAS_SERVICE" = true ]; then
    echo "7. 重啟服務..."
    if [ "$EUID" -eq 0 ]; then
        systemctl restart "${SERVICE_NAME}.service"
    else
        sudo systemctl restart "${SERVICE_NAME}.service"
    fi
    sleep 2
    if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
        echo -e "${GREEN}✓ 服務已重啟並正常運行${NC}"
    else
        echo -e "${RED}❌ 服務重啟後未正常運行，請檢查：${NC}"
        echo "  ${YELLOW}systemctl status ${SERVICE_NAME}.service${NC}"
        echo "  ${YELLOW}journalctl -u ${SERVICE_NAME}.service -n 50${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}7. 未找到 systemd 服務，請自行重啟伺服器程序${NC}"
fi
echo ""

if [ "${STASHED:-false}" = true ]; then
    echo -e "${YELLOW}提醒：更新前暫存的本地變更還在 git stash 裡，確認沒問題後可視情況 'git stash drop'${NC}"
    echo ""
fi

echo "========================================="
echo -e "${GREEN}  更新完成！${NC}"
echo "========================================="

}

main "$@"
