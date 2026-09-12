# 資金週報系統 (Cash Flow Weekly Reporting System)

一個基於 Node.js 和 SQLite 開發的企業級資金週報管理系統，幫助財務主管與經營決策者精準掌握現狀並預見未來風險。

## 🎯 系統目標

- **精準掌握現狀**：即時了解資金流向與帳戶餘額
- **預見未來風險**：透過預測與預警機制，提前發現資金缺口
- **決策支援**：提供差異分析與視覺化報表，協助經營決策

## 📦 功能特色

### 當前版本（已上線功能）
- 🔐 **登入與權限**：Session 認證、管理員／一般使用者角色、全站登出按鈕（含手機版響應式版面）
- ⚠️ **資金缺口儀表板**：即時監控各帳戶餘額、安全水位、預計支出與缺口預測
- 💰 **收支記錄管理**：新增／修改／刪除、Excel 匯入與匯出、批次刪除
- ✅ **餘額結算**：結算記錄維護、期初餘額與收支對帳
- 🏢 **公司管理**：公司主檔維護
- 🏦 **銀行帳戶管理**：帳戶主檔、安全水位、即時餘額重算
- 👥 **人員管理**：使用者帳號與角色（僅管理員）
- 🎛️ **管理者儀表板**（僅管理員）：入口於首頁右下角與導覽「管理」
  - 系統健康狀態（運行時間、Node 版本、DB 狀態、記錄數）
  - 操作日誌（新增／修改／刪除前後差異、黃標註變更欄位）
  - 備份管理：列出備份、建立備份、還原、下載備份檔
- 📊 Excel 收支匯入與匯出（支援民國年日期如 115/2/10；匯出為單一「金額」欄位）
- 💾 SQLite 資料庫、RESTful API、現代化 Web 介面

### 規劃中功能
- 🔄 **數據整合與自動化**：多幣別匯率、銀行對帳單匯入、ERP 對接
- 📅 **資金預測與滾動計畫**：4-13 週滾動預測、融資借貸規劃、異常預警
- 📊 **差異分析**：實績 vs. 預測、差異原因標記、趨勢分析
- 📈 **報表與可視化**：資金結構圖表、現金流走勢圖、PDF/Excel 週報

詳細開發路線圖請參考：`SYSTEM-ROADMAP.md`

## 系統需求

- Ubuntu 24.04
- Node.js 18.x 或更高版本
- npm 或 yarn

## 安裝步驟

### 方式一：一鍵安裝（推薦）

```bash
# 進入專案目錄
cd "資金週報系統"

# 賦予腳本執行權限（僅首次需要）
chmod +x install.sh

# 執行一鍵安裝腳本
./install.sh
```

安裝腳本會自動：
- 引導您選擇部署路徑（當前目錄或 /opt/fund-weekly-report）
- 配置服務端口（預設 3000）
- 配置瀏覽器標題（預設「資金週報系統」）
- 檢查並安裝 Node.js（如需要）
- 安裝所有依賴套件
- 初始化資料庫
- 建立環境配置檔案

**安裝選項說明：**
- **部署路徑**：可選擇部署到當前目錄（開發用）或 `/opt/fund-weekly-report`（生產環境，需要 root 權限）
- **服務端口**：自定義服務運行端口，預設為 3000
- **瀏覽器標題**：自定義瀏覽器分頁顯示的名稱，預設為「資金週報系統」

### 方式二：手動安裝

#### 1. 安裝 Node.js（如果尚未安裝）

```bash
# 使用 NodeSource 安裝 Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 驗證安裝
node --version
npm --version
```

#### 2. 安裝專案依賴

```bash
# 進入專案目錄
cd "資金週報系統"

# 安裝依賴套件
npm install
```

#### 3. 初始化資料庫

```bash
npm run init-db
```

這會建立 SQLite 資料庫檔案 (`database/fund_report.db`) 和必要的資料表。

## 使用方法

### 匯入 Excel 檔案

將 Excel 檔案匯入到資料庫：

```bash
# 匯入預設檔案（B公司與A公司-資金週報1141227.xlsx）
npm run import-excel

# 或指定其他 Excel 檔案路徑
node scripts/import-excel.js /path/to/your/file.xlsx
```

**查看 Excel 檔案結構**（用於除錯和配置）：
```bash
# 方法 1：使用專用腳本（推薦，更詳細）
npm run show-excel

# 方法 2：使用匯入腳本
node scripts/import-excel.js --show-structure
```

這些命令會顯示 Excel 檔案的所有欄位名稱，幫助您確認欄位對應是否正確。

### 啟動伺服器

如果安裝時配置了 systemd 服務，服務會自動啟動，無需手動啟動。

**使用 systemd 服務（推薦生產環境）：**
```bash
# 查看服務狀態
systemctl status fund-weekly-report.service

# 啟動服務
systemctl start fund-weekly-report.service

# 停止服務
systemctl stop fund-weekly-report.service

# 重啟服務
systemctl restart fund-weekly-report.service

# 查看日誌
journalctl -u fund-weekly-report.service -f

# 禁用開機自動啟動
systemctl disable fund-weekly-report.service

# 啟用開機自動啟動
systemctl enable fund-weekly-report.service
```

**手動啟動（開發環境）：**
```bash
# 生產環境
npm start

# 開發環境（自動重啟）
npm run dev
```

伺服器將在 `http://localhost:3000`（或您配置的端口）啟動。

### 使用 Web 介面

1. 開啟瀏覽器，訪問 `http://localhost:3000`（或您配置的端口）
2. 登入後可使用：資金缺口、收支記錄、餘額結算、公司管理、銀行帳戶、人員管理
3. 管理員登入後，首頁右下角與導覽列會顯示「管理」入口，可進入管理者儀表板（系統健康、操作日誌、備份管理）

**注意**：未登入會自動跳轉至登入頁。詳細前端計劃請參考 `FRONTEND-ROADMAP.md`

## API 文檔（摘要）

### 認證
- `GET /api/auth/check`：檢查登入狀態
- `POST /api/auth/login`：登入（username, password）
- `POST /api/auth/logout`：登出

### 業務 API（需登入）
- **收支記錄**：`GET/POST /api/transactions`、`PUT/DELETE /api/transactions/:id`、`POST /api/transactions/batch-delete`、`POST /api/transactions/import`（Excel）
- **公司**：`GET/POST /api/companies`、`PUT/DELETE /api/companies/:id`
- **銀行帳戶**：`GET/POST /api/bank-accounts`、`PUT/DELETE /api/bank-accounts/:id`、`POST /api/bank-accounts/recalculate-balances`
- **餘額結算**：`GET/POST /api/settlements`、`PUT/DELETE /api/settlements/:id`
- **資金缺口**：`GET /api/cash-gap-dashboard`、`GET /api/cash-gap-reconciliation`

### 管理 API（僅管理員）
- **使用者**：`GET/POST /api/users`、`GET/PUT/DELETE /api/users/:id`
- **操作日誌**：`GET /api/admin/operation-logs`（查詢參數：entity_type, action, limit, offset）
- **系統健康**：`GET /api/admin/health`
- **備份**：`GET /api/admin/backups`、`POST /api/admin/backup`、`POST /api/admin/backup/download`、`POST /api/admin/restore`

## Excel 檔案格式

Excel 檔案應該包含以下欄位（欄位名稱支援中英文）：

- **日期** / Date / date / report_date
- **公司名稱** / Company / 公司 / company_name
- **帳戶名稱** / Account / 帳戶 / account_name
- **帳號** / Account Number / account_number
- **餘額** / Balance / 餘額(元) / balance
- **備註** / Remarks / 備註說明 / remarks

如果您的 Excel 檔案使用不同的欄位名稱，請修改 `scripts/import-excel.js` 檔案中的欄位對應邏輯。

## 管理腳本

系統提供了多個便捷的管理腳本，方便日常維護：

### 一鍵安裝

```bash
./install.sh
```

互動式安裝流程，包含：
- 部署路徑選擇（當前目錄或 /opt）
- 服務端口配置
- 瀏覽器標題配置
- 環境檢查、依賴安裝、資料庫初始化

### 一鍵更新

```bash
./update.sh
```

從 GitHub 拉取最新程式碼並重啟服務，包含：
- 自動偵測部署路徑與實際的 systemd 服務名稱（含自訂服務名稱）
- 更新前自動備份資料庫
- 若有未提交的本地變更會先詢問是否暫存（`git stash`），避免 `git pull` 失敗
- 更新相依套件並重啟服務，重啟後自動檢查服務是否正常運行

### 一鍵移除

```bash
./uninstall.sh
```

移除系統相關檔案（node_modules、資料庫、環境配置等），移除前會詢問是否備份資料庫。

**選項說明：**
- 自動偵測部署路徑（支援 /opt 部署）
- 自動檢測並停止執行中的伺服器（使用配置的端口）
- 可選擇是否先備份現有資料庫
- 可選擇是否保留資料庫和環境配置檔案
- 如果部署在 /opt，可選擇是否移除整個部署目錄

### 資料庫備份

```bash
./backup.sh
```

將資料庫檔案備份到 `backups/` 目錄，檔名包含時間戳記。

**功能：**
- 自動偵測部署路徑（支援 /opt 部署）
- 自動建立備份目錄
- 備份檔案命名格式：`fund_report_YYYYMMDD_HHMMSS.db`
- 自動保留最近 30 個備份（超過會自動清理舊備份）
- 顯示備份檔案大小和備份數量統計

### 資料庫還原

```bash
./restore.sh
```

從備份檔案還原資料庫。

**功能：**
- 自動偵測部署路徑（支援 /opt 部署）
- 列出所有可用的備份檔案
- 顯示備份檔案大小和日期
- 還原前會自動備份現有資料庫
- 支援互動式選擇備份檔案

**使用範例：**
```bash
# 還原（互動式選擇）
./restore.sh

# 直接還原指定編號的備份（自動選擇）
./restore.sh 1
```

## 專案結構

```
資金週報系統/
├── database/
│   ├── db.js           # 資料庫連線與初始化
│   ├── schema.sql      # 資料庫結構定義
│   └── fund_report.db  # SQLite 資料庫檔案（自動產生）
├── config/
│   └── excel-mapping.js # Excel 匯入欄位對應
├── scripts/
│   ├── init-db.js      # 資料庫初始化腳本
│   ├── import-excel.js # Excel 匯入腳本
│   ├── create-admin.js # 建立管理員帳號
│   └── show-excel-structure.js # 檢視 Excel 結構
├── public/
│   ├── index.html      # 首頁（登入後顯示功能卡片）
│   ├── login.html      # 登入頁
│   ├── cash-gap-dashboard.html  # 資金缺口儀表板
│   ├── transactions.html       # 收支記錄管理
│   ├── settlement.html        # 餘額結算
│   ├── companies.html         # 公司管理
│   ├── bank-accounts.html     # 銀行帳戶管理
│   ├── users.html             # 人員管理
│   ├── admin-dashboard.html   # 管理者儀表板
│   ├── admin-system-health.html # 系統健康狀態
│   ├── admin-operation-logs.html # 操作日誌
│   └── admin-backup.html      # 備份管理
├── docs/
│   └── 資金缺口-A公司數值差異說明.md
├── backups/            # 備份目錄（可自訂 BACKUP_PATH）
├── install.sh / update.sh / uninstall.sh / backup.sh / restore.sh
├── server.js           # Express 主程式（含 API 與操作日誌）
├── package.json
├── README.md / QUICK-START.md / SYSTEM-ROADMAP.md / FIX-INSTALL.md / SCRIPTS.md / CHANGELOG.md
└── EXCEL-ANALYSIS.md / FRONTEND-ROADMAP.md
```

## 資料庫結構

主要資料表：`users`（使用者與角色）、`companies`（公司）、`bank_accounts`（銀行帳戶）、`transactions`（收支記錄）、`balance_settlements`（餘額結算）、`operation_logs`（操作日誌，供管理員查詢）。完整定義請見 `database/schema.sql`。

## 配置說明

系統配置檔案位於 `.env`，包含以下選項：

- `PORT`: 服務運行端口（預設 3000）
- `HOST`: 服務綁定地址（預設 0.0.0.0，允許外部訪問）
- `APP_TITLE`: 瀏覽器標題（預設「資金週報系統」）
- `NODE_ENV`: 運行環境（production/development）
- `DEPLOY_PATH`: 部署路徑
- `DB_PATH`: 資料庫檔案路徑（若未設則使用 `database/fund_report.db`）
- `BACKUP_PATH`: 備份目錄（可自訂；未設則使用部署路徑下 `backups/`）
- `SESSION_SECRET`: Session 加密金鑰（建議生產環境自訂）
- `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID`: M365 / Entra ID SSO 登入設定（選用，見下）

安裝時會自動建立 `.env` 檔案，之後可手動編輯進行調整。

### M365 / Entra ID SSO 登入（選用）

在 `.env` 同時填入 `ENTRA_TENANT_ID` 和 `ENTRA_CLIENT_ID` 後重啟服務，登入頁會自動出現「使用 M365 登入」按鈕；兩者留空則完全不受影響，維持原本的帳號密碼登入。

**運作方式：**
- 前端用 MSAL.js（瀏覽器端，無需再存任何密鑰）走 Authorization Code + PKCE 流程取得 Entra ID token
- 後端驗證 token 簽章與 issuer/audience，取出 email 後比對 `users` 表中**已存在且啟用中**的帳號
- 找不到對應帳號會直接拒絕登入（403），**不會自動建立新帳號**——要開放某人用 M365 登入，必須先用「人員管理」頁面建立一個 `email` 欄位相符的帳號
- 帳號密碼登入不受影響，可作為 SSO 無法使用時的備援

**Entra ID App Registration 設定需求：**
- 平台類型選 **單頁應用程式 (SPA)**
- Redirect URI 設為 `https://你的網域/login.html`（例如 `https://cashflow.ai4ou.com/login.html`）
- API 權限：`openid`、`profile`、`email`（Microsoft Graph 委派權限，通常免管理員同意）
- Client ID 不是機密（SPA 公開用戶端本就設計成可以放在前端程式碼中），可以安心寫在 `.env` 裡

**常駐服務說明：**
- 安裝時可選擇配置 systemd 常駐服務
- 配置後系統會自動啟動，並在開機時自動啟動
- 服務名稱：`fund-weekly-report.service`
- 服務會在崩潰時自動重啟（RestartSec=10秒）
- 日誌可通過 `journalctl -u fund-weekly-report.service -f` 查看

**網路訪問說明：**
- 預設綁定到 `0.0.0.0`，允許從任何網路介面訪問
- 本地訪問：`http://localhost:端口`
- 外部訪問：`http://主機IP:端口`（同一網路內的其他設備可使用此地址）
- 啟動伺服器時會自動顯示可用的訪問地址

## 注意事項

1. 首次使用前請先執行 `npm run init-db` 或使用 `./install.sh` 初始化資料庫
2. Excel 匯入前建議先使用 `--show-structure` 參數查看檔案結構
3. 資料庫檔案 (`fund_report.db`) 位於 `database/` 目錄下，建議定期使用 `./backup.sh` 備份
4. 修改 Excel 欄位對應時，請參考 `config/excel-mapping.js` 檔案
5. 所有管理腳本需要在 Ubuntu/Linux 環境下執行（Windows 環境請使用 WSL 或 Git Bash）
6. 部署到 `/opt` 目錄需要 root 權限，建議使用 `sudo ./install.sh`
7. 部署到 `/opt` 後，所有腳本需要在該目錄下執行
8. 瀏覽器標題會根據 `.env` 中的 `APP_TITLE` 自動更新

## 故障排除

### 腳本無法執行

**問題：** `-bash: ./install.sh: cannot execute: required file not found`

**原因：** 通常是換行符格式問題（Windows CRLF vs Linux LF）

**解決方法：**
```bash
# 使用 sed 修復換行符
sed -i 's/\r$//' install.sh update.sh uninstall.sh backup.sh restore.sh
chmod +x install.sh update.sh uninstall.sh backup.sh restore.sh

# 或一次性修復所有 .sh 文件
for file in *.sh; do sed -i 's/\r$//' "$file" && chmod +x "$file"; done
```

詳細說明請參考 `FIX-INSTALL.md` 檔案。

### 匯入失敗
- 檢查 Excel 檔案路徑是否正確
- 使用 `--show-structure` 查看 Excel 結構
- 檢查欄位名稱是否正確對應

### 資料庫錯誤
- 確認已執行 `npm run init-db`
- 檢查資料庫檔案權限
- 查看伺服器日誌錯誤訊息

### 伺服器無法啟動
- 確認 Node.js 版本（需要 18.x 或更高）
- 檢查 3000 端口是否被占用（或您配置的端口）
- 確認所有依賴已正確安裝 (`npm install`)
- 檢查 `.env` 檔案中的 PORT 配置是否正確

## 授權

ISC License

## 聯絡資訊

如有問題或建議，請聯繫開發團隊。
