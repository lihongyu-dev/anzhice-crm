#!/usr/bin/env bash
# 认证冒烟测试。用法：BASE=http://127.0.0.1:3001 PW=<密码> bash scripts/smoke-auth.sh
# 写成脚本而不是内联命令：内联时 shell 里的凭证赋值会被日志脱敏改写，导致语法错误。
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:3001}"
: "${PW:?需要设置 PW 环境变量}"

hdr=$(mktemp)
trap 'rm -f "$hdr"' EXIT

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "1. 未登录打 API           期望 404  实际 $(code "$BASE/api/gold-labels")"
echo "2. 未登录开标注页         期望 307  实际 $(code "$BASE/app/label")"
echo "3. 错密码                 期望 401  实际 $(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"password":"definitely-wrong"}')"

body=$(node -e 'console.log(JSON.stringify({password:process.env.PW}))')
login=$(curl -s -D "$hdr" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "$body")
echo "4. 对密码                 期望 200  实际 $login"

ck=$(sed -n 's/.*az_session=\([^;]*\).*/\1/p' "$hdr" | head -1)
if [ -z "$ck" ]; then echo "   未取到会话 cookie，后续跳过"; exit 1; fi
echo "   cookie 属性: $(grep -io 'httponly\|secure\|samesite=[a-z]*' "$hdr" | tr '\n' ' ')"

echo "5. 带 cookie 打 API       期望 200  实际 $(code -H "Cookie: az_session=$ck" "$BASE/api/gold-labels")"
echo "6. 带 cookie 开标注页     期望 200  实际 $(code -H "Cookie: az_session=$ck" "$BASE/app/label")"
echo "7. 篡改签名               期望 404  实际 $(code -H "Cookie: az_session=${ck%?}X" "$BASE/api/gold-labels")"
echo "8. 已登录再开 /login      期望 307  实际 $(code -H "Cookie: az_session=$ck" "$BASE/login")"
