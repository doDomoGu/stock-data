#!/usr/bin/env bash
# 从 nginx 访问日志生成 GoAccess 报表（供 /traffic/ 查看）
#
# 这套 goaccess 构建不支持直接读 .gz，所以先把轮转日志解压到 unpacked/，
# 再和当前日志一起统计，得到最近约 7 天的数据。
set -euo pipefail

LOG_DIR=/var/log/nginx
UNPACKED="$LOG_DIR/unpacked"
OUT_DIR=/var/www/traffic
OUT="$OUT_DIR/index.html"

mkdir -p "$UNPACKED" "$OUT_DIR"

# 解压还没解压过的轮转日志
for gz in "$LOG_DIR"/access.log-*.gz; do
  [ -e "$gz" ] || continue
  base=$(basename "$gz" .gz)
  [ -f "$UNPACKED/$base" ] || zcat "$gz" > "$UNPACKED/$base"
done
# 只保留 8 天
find "$UNPACKED" -name 'access.log-*' -mtime +8 -delete

FILES=("$LOG_DIR/access.log")
for f in "$UNPACKED"/access.log-*; do
  [ -e "$f" ] && FILES+=("$f")
done

# goaccess 会校验输出文件后缀（必须是 .html/.json/.csv），
# 所以临时文件放同目录并带 .html 后缀，保证最后能原子替换
TMP=$(mktemp "$OUT_DIR/.index.XXXXXX.html")
TMP_BOTS=$(mktemp "$OUT_DIR/.crawlers.XXXXXX.html")

# 主报表只统计真人访问；爬虫/扫描器单独出一份，避免"独立访客"被机器流量灌水
goaccess "${FILES[@]}" \
  --log-format='%h %^[%d:%t %^] "%r" %s %b "%R" "%u" %^' \
  --date-format='%d/%b/%Y' \
  --time-format='%T' \
  --no-global-config \
  --tz=Asia/Shanghai \
  --ignore-crawlers \
  -o "$TMP" >/dev/null 2>&1

goaccess "${FILES[@]}" \
  --log-format='%h %^[%d:%t %^] "%r" %s %b "%R" "%u" %^' \
  --date-format='%d/%b/%Y' \
  --time-format='%T' \
  --no-global-config \
  --tz=Asia/Shanghai \
  --crawlers-only \
  -o "$TMP_BOTS" >/dev/null 2>&1

# 原子替换，避免访问时读到写了一半的报表
install -m 644 "$TMP" "$OUT"
install -m 644 "$TMP_BOTS" "$OUT_DIR/crawlers.html"
rm -f "$TMP" "$TMP_BOTS"
