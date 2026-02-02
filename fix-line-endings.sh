#!/bin/bash
# 修復所有腳本文件的換行符（Windows CRLF -> Linux LF）

for file in *.sh; do
    if [ -f "$file" ]; then
        # 使用 sed 移除 Windows 的 CR 字符
        sed -i 's/\r$//' "$file"
        # 賦予執行權限
        chmod +x "$file"
        echo "✓ 已修復: $file"
    fi
done

echo ""
echo "所有腳本文件已修復完成！"

