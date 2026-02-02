# 修復 install.sh 執行錯誤

如果遇到 `cannot execute: required file not found` 錯誤，通常是換行符格式問題。

## 快速修復方法

在 Linux 系統上執行以下命令：

```bash
# 方法 1: 使用 dos2unix（如果已安裝）
dos2unix install.sh uninstall.sh backup.sh restore.sh
chmod +x install.sh uninstall.sh backup.sh restore.sh

# 方法 2: 使用 sed（所有 Linux 系統都有）
sed -i 's/\r$//' install.sh uninstall.sh backup.sh restore.sh
chmod +x install.sh uninstall.sh backup.sh restore.sh

# 方法 3: 使用 tr
tr -d '\r' < install.sh > install.sh.tmp && mv install.sh.tmp install.sh
tr -d '\r' < uninstall.sh > uninstall.sh.tmp && mv uninstall.sh.tmp uninstall.sh
tr -d '\r' < backup.sh > backup.sh.tmp && mv backup.sh.tmp backup.sh
tr -d '\r' < restore.sh > restore.sh.tmp && mv restore.sh.tmp restore.sh
chmod +x install.sh uninstall.sh backup.sh restore.sh
```

## 一次性修復所有腳本

```bash
# 修復所有 .sh 文件
for file in *.sh; do
    if [ -f "$file" ]; then
        sed -i 's/\r$//' "$file"
        chmod +x "$file"
        echo "✓ 已修復: $file"
    fi
done
```

## 驗證修復

修復後，可以使用以下命令驗證：

```bash
# 檢查文件格式（如果有 file 命令）
file install.sh

# 應該顯示: install.sh: Bourne-Again shell script, ASCII text executable
# 不應該包含 "CRLF" 或 "with CR line terminators"
```

## 安裝 dos2unix（可選）

如果需要經常處理這類問題，可以安裝 dos2unix：

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install dos2unix

# CentOS/RHEL
sudo yum install dos2unix
```

然後使用：
```bash
dos2unix *.sh
chmod +x *.sh
```

## 修復後執行安裝

```bash
./install.sh
```
