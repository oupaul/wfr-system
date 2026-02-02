# 管理腳本快速參考

本文檔提供資金週報系統所有管理腳本的詳細說明。

## 腳本列表

| 腳本 | 功能 | 使用場景 |
|------|------|----------|
| `install.sh` | 一鍵安裝 | 首次安裝或重新安裝 |
| `uninstall.sh` | 一鍵移除 | 移除系統或清理環境 |
| `backup.sh` | 資料庫備份 | 定期備份或重要操作前 |
| `restore.sh` | 資料庫還原 | 從備份還原資料庫 |

## 詳細說明

### install.sh - 一鍵安裝

自動完成所有安裝步驟，包括環境檢查、依賴安裝、資料庫初始化等。

**使用方法：**
```bash
chmod +x install.sh    # 首次執行需要賦予執行權限
./install.sh
```

**功能：**
- ✅ 檢查 Node.js 是否已安裝（如未安裝會提示安裝選項）
- ✅ 驗證 Node.js 版本（需要 18.x 或更高）
- ✅ 安裝所有 npm 依賴套件
- ✅ 初始化 SQLite 資料庫
- ✅ 建立環境配置檔案 (.env)
- ✅ 設定腳本執行權限

**注意事項：**
- 如果系統中沒有 Node.js，腳本會提供安裝選項
- 需要 root 權限時會要求輸入密碼（僅在安裝 Node.js 時）

---

### uninstall.sh - 一鍵移除

移除系統相關檔案，移除前會詢問是否備份資料庫。

**使用方法：**
```bash
chmod +x uninstall.sh    # 首次執行需要賦予執行權限
./uninstall.sh
```

**移除內容：**
- `node_modules/` - 依賴套件目錄
- `database/fund_report.db` - 資料庫檔案（可選）
- `.env` - 環境配置檔案（可選）
- 暫存檔案（npm-debug.log 等）

**互動選項：**
1. 停止執行中的伺服器（如果發現）
2. 備份現有資料庫（在移除前）
3. 是否移除資料庫檔案
4. 是否移除環境配置檔案

**注意事項：**
- 預設會保留原始碼檔案（package.json、server.js 等）
- 如需完全移除，請手動刪除專案目錄
- 建議在移除前先執行 `./backup.sh` 備份資料

---

### backup.sh - 資料庫備份

將資料庫檔案備份到 `backups/` 目錄。

**使用方法：**
```bash
chmod +x backup.sh    # 首次執行需要賦予執行權限
./backup.sh
```

**功能：**
- ✅ 自動建立 `backups/` 目錄（如不存在）
- ✅ 備份檔案命名格式：`fund_report_YYYYMMDD_HHMMSS.db`
- ✅ 顯示備份檔案大小和位置
- ✅ 列出最近 5 個備份檔案
- ✅ 自動清理舊備份（保留最近 30 個）

**備份檔案範例：**
```
backups/
├── fund_report_20241227_143025.db
├── fund_report_20241227_150130.db
└── fund_report_20241227_163045.db
```

**建議使用時機：**
- 定期備份（建議每日或每週）
- 重要操作前（如匯入大量資料、更新系統）
- 升級前備份

**自動清理：**
- 當備份數量超過 30 個時，會自動刪除最舊的備份
- 僅保留最近的 30 個備份檔案

---

### restore.sh - 資料庫還原

從備份檔案還原資料庫。

**使用方法：**
```bash
chmod +x restore.sh    # 首次執行需要賦予執行權限

# 方式一：互動式選擇備份檔案
./restore.sh

# 方式二：直接指定備份編號
./restore.sh 1
```

**功能：**
- ✅ 列出所有可用的備份檔案
- ✅ 顯示備份檔案大小和建立日期
- ✅ 還原前自動備份現有資料庫（如存在）
- ✅ 互動式選擇或直接指定備份編號
- ✅ 還原確認機制（防止誤操作）

**還原流程：**
1. 列出所有備份檔案（按時間排序，最新的在前）
2. 選擇要還原的備份檔案（輸入編號或直接指定）
3. 如果目標資料庫已存在，詢問是否先備份
4. 確認還原操作
5. 執行還原並顯示結果

**還原前備份：**
- 如果目標資料庫檔案已存在，腳本會詢問是否先備份
- 備份檔案命名：`fund_report_pre_restore_YYYYMMDD_HHMMSS.db`
- 這樣可以避免還原後無法恢復到還原前的狀態

**注意事項：**
- 還原操作會覆蓋現有資料庫檔案
- 建議還原後重新啟動伺服器
- 建議在還原前手動備份當前資料庫

---

## 使用範例

### 完整安裝流程

```bash
# 1. 進入專案目錄
cd "資金週報系統"

# 2. 一鍵安裝
./install.sh

# 3. 匯入 Excel 資料
npm run import-excel

# 4. 啟動伺服器
npm start
```

### 定期備份流程

```bash
# 每日備份（可加入 crontab）
./backup.sh

# 或手動備份
./backup.sh
```

### 系統維護流程

```bash
# 1. 備份資料庫
./backup.sh

# 2. 移除系統（測試環境）
./uninstall.sh

# 3. 重新安裝
./install.sh

# 4. 如需還原，使用還原腳本
./restore.sh
```

### 故障恢復流程

```bash
# 1. 查看可用備份
ls -lh backups/

# 2. 還原到最近的備份
./restore.sh 1

# 3. 重新啟動伺服器
npm start
```

---

## 排程備份（Crontab）

可以設定 cron 任務自動備份資料庫：

```bash
# 編輯 crontab
crontab -e

# 每天凌晨 2 點自動備份
0 2 * * * cd /path/to/資金週報系統 && ./backup.sh >> /var/log/fund_backup.log 2>&1

# 每週日凌晨 3 點備份
0 3 * * 0 cd /path/to/資金週報系統 && ./backup.sh >> /var/log/fund_backup.log 2>&1
```

---

## 疑難排解

### 腳本無法執行

**問題：** `bash: ./install.sh: Permission denied`

**解決方法：**
```bash
chmod +x install.sh uninstall.sh backup.sh restore.sh
```

### 備份目錄權限問題

**問題：** `備份目錄沒有寫入權限`

**解決方法：**
```bash
mkdir -p backups
chmod 755 backups
```

### 找不到資料庫檔案

**問題：** `找不到資料庫檔案: database/fund_report.db`

**解決方法：**
```bash
# 先初始化資料庫
npm run init-db

# 或重新安裝
./install.sh
```

### 還原失敗

**問題：** 還原操作失敗

**檢查項目：**
1. 備份檔案是否存在且完整
2. 資料庫目錄是否有寫入權限
3. 是否有其他程式正在使用資料庫檔案

**解決方法：**
```bash
# 檢查備份檔案
ls -lh backups/

# 檢查權限
ls -ld database/

# 停止伺服器後再還原
pkill -f "node server.js"
./restore.sh
```

---

## 注意事項

1. ⚠️ 所有腳本需要在 Ubuntu/Linux 環境下執行
2. ⚠️ Windows 環境請使用 WSL 或 Git Bash
3. ⚠️ 執行腳本前建議先閱讀輸出訊息
4. ⚠️ 重要操作前請務必備份資料庫
5. ⚠️ 移除操作不可逆，請謹慎執行

---

## 相關檔案

- `README.md` - 完整系統說明文件
- `package.json` - 專案配置和 npm 腳本
- `database/schema.sql` - 資料庫結構定義
- `config/excel-mapping.js` - Excel 欄位對應配置
