#!/bin/bash
# 資金週報系統 - 從 GitHub 非互動式一鍵部署（Ubuntu）
#
# 全新主機上貼一行就好（用有 sudo 權限的一般帳號執行，服務會以這個帳號運行）：
#   curl -fsSL https://raw.githubusercontent.com/oupaul/wfr-system/main/deploy.sh | sudo bash -s -- --port 6664 --name cashflow-prod
#
# 做的事：安裝必要工具與 Node.js（已有 20.17 以上就沿用）→ git clone 到 /opt/<名稱> → npm 安裝 → 初始化資料庫
#         → 建立 admin 隨機密碼（只顯示一次）→ 寫 .env（隨機 SESSION_SECRET）→ 建立並啟動 systemd 服務 → 健康檢查。
# 全程不需要回答任何問題。已存在的部署目錄或服務不會被覆蓋（會直接停下來，要更新請用該目錄的 ./update.sh）。
#
# 選項：
#   --port N        服務端口（預設 3000）
#   --name NAME     systemd 服務名稱，也是預設的資料夾名稱（預設 cashflow）
#   --dir PATH      部署目錄（預設 /opt/<NAME>）
#   --user USER     以哪個帳號運行服務（預設：執行 sudo 的那個帳號）
#   --title TEXT    瀏覽器標題（預設：資金週報系統）
#   --timeout MIN   閒置自動登出分鐘數（預設 30）
#   --repo URL      程式碼來源（預設 GitHub 的 oupaul/wfr-system）
#   --branch NAME   分支（預設 main）
#   --no-service    不建立 systemd 服務（只安裝，之後自己用 npm start 啟動）
#   --skip-packages 不用 apt 安裝工具、不安裝 Node.js（測試或已備妥環境用）
#   --help          顯示說明

set -euo pipefail

# 整段包在 main() 裡，最後才呼叫：用 curl | bash 執行時，bash 必須完整讀進整支腳本才開始執行，避免讀到一半網路中斷造成半套安裝
main() {
    local PORT=3000 NAME=cashflow DIR="" RUN_USER="" TITLE="資金週報系統" TIMEOUT_MIN=30
    local REPO="https://github.com/oupaul/wfr-system.git" BRANCH=main
    local NO_SERVICE=false SKIP_PACKAGES=false

    local RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'
    say()  { echo -e "${BLUE}==>${NC} $*"; }
    ok()   { echo -e "${GREEN}✓${NC} $*"; }
    warn() { echo -e "${YELLOW}⚠${NC} $*"; }
    die()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

    while [ $# -gt 0 ]; do
        case "$1" in
            --port) PORT="${2:-}"; shift 2 ;;
            --name) NAME="${2:-}"; shift 2 ;;
            --dir) DIR="${2:-}"; shift 2 ;;
            --user) RUN_USER="${2:-}"; shift 2 ;;
            --title) TITLE="${2:-}"; shift 2 ;;
            --timeout) TIMEOUT_MIN="${2:-}"; shift 2 ;;
            --repo) REPO="${2:-}"; shift 2 ;;
            --branch) BRANCH="${2:-}"; shift 2 ;;
            --no-service) NO_SERVICE=true; shift ;;
            --skip-packages) SKIP_PACKAGES=true; shift ;;
            --help|-h) sed -n '2,27p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
            *) die "不認得的選項：$1（用 --help 看說明）" ;;
        esac
    done

    [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port 必須是 1-65535 的數字"
    [[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "--name 只能用英文、數字、. _ -"
    [[ "$TIMEOUT_MIN" =~ ^[0-9]+$ ]] && [ "$TIMEOUT_MIN" -ge 1 ] || die "--timeout 必須是正整數（分鐘）"
    [ -n "$DIR" ] || DIR="/opt/$NAME"

    # 運行服務的帳號：不要用 root。檔案若變成 root 擁有，服務（以一般帳號運行）寫不了資料庫，登入時會崩潰
    if [ -z "$RUN_USER" ]; then RUN_USER="${SUDO_USER:-$(id -un)}"; fi
    if [ "$RUN_USER" = "root" ]; then die "請用一般帳號加 sudo 執行（例如 itadmin：curl ... | sudo bash -s -- ...），或用 --user 指定運行服務的帳號；不建議用 root 運行"; fi
    id "$RUN_USER" >/dev/null 2>&1 || die "找不到使用者 $RUN_USER"

    local IS_ROOT=false; [ "$(id -u)" -eq 0 ] && IS_ROOT=true
    # 以 RUN_USER 身分執行指令（本身就是該使用者時直接執行）
    run_as() { if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi; }

    echo "========================================="
    echo "  資金週報系統 - 一鍵部署"
    echo "========================================="
    echo "  部署目錄 : $DIR"
    echo "  服務名稱 : $NAME$([ "$NO_SERVICE" = true ] && echo '（不建立 systemd 服務）')"
    echo "  端口     : $PORT"
    echo "  運行帳號 : $RUN_USER"
    echo "  程式碼   : $REPO ($BRANCH)"
    echo ""

    # ---- 0. 不覆蓋既有部署 ----
    if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
        die "$DIR 已存在且不是空的，不會覆蓋。要更新請執行：cd $DIR && ./update.sh；要全新重裝請先備份並手動移走該目錄"
    fi
    if [ "$NO_SERVICE" = false ] && [ -e "/etc/systemd/system/$NAME.service" ]; then
        die "服務 $NAME 已存在（/etc/systemd/system/$NAME.service），不會覆蓋。請換 --name，或先處理既有服務"
    fi
    if [ "$NO_SERVICE" = false ] && [ "$IS_ROOT" = false ]; then die "建立 systemd 服務需要 root，請用 sudo 執行（或加 --no-service）"; fi
    if [[ "$DIR" == /opt/* ]] && [ "$IS_ROOT" = false ]; then die "部署到 /opt 需要 root，請用 sudo 執行，或用 --dir 指定你有寫入權限的目錄"; fi

    # ---- 1. 系統工具 ----
    if [ "$SKIP_PACKAGES" = false ]; then
        [ "$IS_ROOT" = true ] || die "安裝系統工具需要 root，請用 sudo 執行（或加 --skip-packages 自行備妥 git、curl、build-essential、python3）"
        command -v apt-get >/dev/null 2>&1 || die "這支腳本只支援 Debian／Ubuntu（找不到 apt-get）"
        say "安裝系統工具（git curl build-essential python3）..."
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y >/dev/null
        apt-get install -y git curl ca-certificates build-essential python3 >/dev/null
        ok "系統工具已就緒"
    else
        command -v git >/dev/null 2>&1 || die "找不到 git"
    fi

    # ---- 2. Node.js（已有 20.17 以上就沿用，包含 nvm 安裝的）----
    local NODE_BIN
    NODE_BIN="$(run_as bash -lc 'command -v node' 2>/dev/null || true)"
    if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
    # 需要 Node.js 20.17 以上（package.json engines；sqlite3 6 需要）
    node_ok() { "$1" -e "const c=process.versions.node.split('.').map(Number); process.exit((c[0]>20||(c[0]===20&&c[1]>=17))?0:1)" 2>/dev/null; }
    if [ -z "$NODE_BIN" ] || ! node_ok "$NODE_BIN"; then
        [ "$SKIP_PACKAGES" = false ] || die "需要 Node.js 20.17 以上（目前：${NODE_BIN:+$("$NODE_BIN" --version)}${NODE_BIN:-未安裝}）"
        say "安裝 Node.js 22（目前：${NODE_BIN:+$("$NODE_BIN" --version)}${NODE_BIN:-未安裝}）..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
        apt-get install -y nodejs >/dev/null
        NODE_BIN="$(command -v node)"
        node_ok "$NODE_BIN" || die "Node.js 安裝後版本仍不符（需要 20.17 以上）"
    fi
    local NODE_DIR; NODE_DIR="$(dirname "$NODE_BIN")"
    ok "Node.js $("$NODE_BIN" --version)（$NODE_BIN）"
    # 讓後面 npm / node 一律用同一個 Node（nvm 安裝的 Node 不在 sudo 的 PATH 裡）
    export PATH="$NODE_DIR:$PATH"
    nr() { run_as env "PATH=$NODE_DIR:$PATH" "$@"; }

    # ---- 3. 取得程式碼（clone 到部署目錄，之後 update.sh 直接在裡面 git pull）----
    say "從 $REPO 取得程式碼..."
    if [ "$IS_ROOT" = true ]; then mkdir -p "$DIR"; chown "$RUN_USER" "$DIR"; else mkdir -p "$DIR"; fi
    run_as git clone --branch "$BRANCH" "$REPO" "$DIR" >/dev/null 2>&1 || die "git clone 失敗（網路、分支名稱或 --repo 是否正確？）"
    [ -f "$DIR/server.js" ] && [ -f "$DIR/package.json" ] || die "取得的程式碼不完整（找不到 server.js／package.json）"
    ok "程式碼已放到 $DIR（$(cd "$DIR" && run_as git log --oneline -1)）"

    # ---- 4. 安裝套件與初始化資料庫 ----
    say "安裝套件（第一次約需 1～3 分鐘，sqlite3／argon2 有預編譯檔時很快）..."
    ( cd "$DIR" && { nr npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || nr npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1; } ) \
        || die "npm 安裝失敗。請進 $DIR 執行 'npm rebuild sqlite3 argon2' 或手動 'npm install' 看詳細錯誤（需要 build-essential、python3）"
    # 原生模組（sqlite3、argon2）要能載入；新版 npm 的安裝腳本管控可能略過編譯，載入失敗就重新編譯一次
    if ! ( cd "$DIR" && nr node -e "require('sqlite3');require('argon2')" >/dev/null 2>&1 ); then
        warn "原生模組載入失敗，重新編譯..."
        ( cd "$DIR" && nr npm rebuild sqlite3 argon2 >/dev/null 2>&1 && nr node -e "require('sqlite3');require('argon2')" >/dev/null 2>&1 ) \
            || die "sqlite3／argon2 無法載入。請確認已安裝 build-essential python3，進 $DIR 執行 'npm rebuild sqlite3 argon2' 看詳細錯誤"
    fi
    ok "套件安裝完成"
    say "初始化資料庫..."
    ( cd "$DIR" && nr npm run init-db >/dev/null 2>&1 ) || die "資料庫初始化失敗（進 $DIR 執行 'npm run init-db' 看詳細錯誤）"
    ok "資料庫已建立（$DIR/database/fund_report.db）"

    # ---- 5. 管理員帳號（隨機密碼，只顯示一次）----
    local ADMIN_PW; ADMIN_PW="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(9).toString('base64').replace(/[+/=]/g, ''))")"
    say "建立管理員帳號 admin..."
    # 密碼用標準輸入傳給 node，不放在命令列參數或環境變數（避免被 ps 看到）
    ( cd "$DIR" && nr node -e "
const argon2 = require('argon2');
const { db, initDatabase } = require('./database/db');
(async () => {
  try {
    const pw = require('fs').readFileSync(0, 'utf8').trim();
    await initDatabase();
    const exists = await new Promise((res, rej) => db.get('SELECT id FROM users WHERE username = ?', ['admin'], (e, r) => e ? rej(e) : res(r)));
    if (exists) { console.log('EXISTS'); process.exit(0); }
    const hash = await argon2.hash(pw, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    await new Promise((res, rej) => db.run('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)', ['admin', hash, '系統管理員', 'admin', 1], (e) => e ? rej(e) : res()));
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(1); }
})();
" >/dev/null 2>&1 <<<"$ADMIN_PW" ) || die "建立管理員失敗，請之後執行：cd $DIR && node scripts/create-admin.js admin <密碼>"
    ok "管理員帳號已建立"

    # ---- 6. 設定檔 ----
    local SESSION_SECRET_VALUE; SESSION_SECRET_VALUE="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
    local BACKUP_PATH="$DIR/backups"
    run_as bash -c "cat > '$DIR/.env'" <<EOF
# 資金週報系統環境配置（由 deploy.sh 產生）
PORT=$PORT
HOST=0.0.0.0
NODE_ENV=production
APP_TITLE=$TITLE
DEPLOY_PATH=$DIR

TRANSACTION_MODE=full

# Session 配置
SESSION_TIMEOUT=$((TIMEOUT_MIN * 60 * 1000))
SESSION_SECRET=$SESSION_SECRET_VALUE

DB_PATH=database/fund_report.db
BACKUP_PATH=$BACKUP_PATH

# 允許跨來源帶憑證存取 API 的網域（選用，一般不需要）
# ALLOWED_ORIGINS=
EOF
    run_as chmod 600 "$DIR/.env"
    run_as bash -c "cat > '$DIR/.install-config'" <<EOF
DEPLOY_PATH=$DIR
BACKUP_PATH=$BACKUP_PATH
INSTALL_PORT=$PORT
INSTALL_TITLE=$TITLE
INSTALL_TO_OPT=$([[ "$DIR" == /opt/* ]] && echo true || echo false)
ENABLE_SERVICE=$([ "$NO_SERVICE" = true ] && echo false || echo true)
SERVICE_NAME=$NAME
INSTALL_DATE=$(TZ=CST-8 date '+%Y-%m-%d %H:%M:%S')
EOF
    run_as mkdir -p "$BACKUP_PATH"
    run_as chmod +x "$DIR"/*.sh 2>/dev/null || true
    ok "設定檔已建立（.env 的 SESSION_SECRET 為隨機產生）"

    # ---- 7. systemd 服務 ----
    if [ "$NO_SERVICE" = false ]; then
        say "建立並啟動 systemd 服務 $NAME..."
        cat > "/etc/systemd/system/$NAME.service" <<EOF
[Unit]
Description=資金週報系統 (Fund Weekly Report System)
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
Environment="NODE_ENV=production"
Environment="PORT=$PORT"
Environment="HOST=0.0.0.0"
Environment="APP_TITLE=$TITLE"
Environment="TRANSACTION_MODE=full"
Environment="DEPLOY_PATH=$DIR"
Environment="BACKUP_PATH=$BACKUP_PATH"
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$NAME

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable "$NAME.service" >/dev/null 2>&1
        systemctl start "$NAME.service"
        ok "服務已啟動"
    fi

    # ---- 8. 健康檢查 ----
    local HEALTHY=false
    if [ "$NO_SERVICE" = false ]; then
        say "等待服務回應..."
        for _ in $(seq 1 20); do
            if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then HEALTHY=true; break; fi
            sleep 1
        done
        if [ "$HEALTHY" = true ]; then ok "服務正常（http://127.0.0.1:$PORT）"; else warn "服務 20 秒內沒有回應，請檢查：sudo systemctl status $NAME.service ／ sudo journalctl -u $NAME.service -n 50"; fi
    fi

    echo ""
    echo "========================================="
    echo -e "  ${GREEN}部署完成${NC}"
    echo "========================================="
    echo "  網址      : http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT   （對外請加 nginx／Cloudflare Tunnel 與 HTTPS）"
    echo "  管理員    : admin"
    echo -e "  ${YELLOW}密碼      : $ADMIN_PW${NC}"
    echo -e "  ${RED}⚠ 這組密碼只顯示這一次，請立刻記下，登入後馬上修改。${NC}"
    echo ""
    echo "  之後更新  : cd $DIR && ./update.sh"
    if [ "$NO_SERVICE" = false ]; then
        echo "  服務管理  : sudo systemctl status|restart|stop $NAME"
        echo "  看紀錄    : sudo journalctl -u $NAME -f"
    else
        echo "  啟動      : cd $DIR && npm start"
    fi
    echo "  備份      : 登入後到「管理者儀表板 → 備份管理」設定每日自動備份排程"
    echo ""
}

main "$@"
