#!/bin/bash
# PacketLabManager — Linux 시작 스크립트

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT/server"

# LC_NUMERIC=ko_KR 등 혼합 로케일이 cap/pcap C 라이브러리의 heap 오류를 유발함.
# native 모듈 안정성을 위해 숫자·문자 처리 로케일을 C로 고정.
export LC_ALL=C
export LANG=en_US.UTF-8

# 내 IP 감지 (169.254.x.x 링크로컬 포함)
MY_IP=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+' | head -1)
MY_LINK=$(ip -4 addr show scope link 2>/dev/null | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+' | grep -v '^127\.' | head -1)
[ -z "$MY_IP" ] && MY_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$MY_IP" ] && MY_IP="localhost"

echo ""
echo "  ============================================="
echo "   PacketLabManager  -  Port 8080"
echo "   Local     : http://localhost:8080"
[ -n "$MY_IP" ]   && echo "   Network   : http://$MY_IP:8080"
[ -n "$MY_LINK" ] && echo "   Link-Local: http://$MY_LINK:8080"
echo "  ============================================="
echo ""

cd "$SERVER_DIR"

# npm install (node_modules 없을 때)
if [ ! -d node_modules ]; then
    echo "[1/2] npm install..."
    npm install
fi

echo "[2/2] Starting server (requires root for packet capture/send)..."
echo ""

if [ "$(id -u)" -ne 0 ]; then
    echo "  [WARN] root 아님 — 패킷 전송/캡처에 root 권한 필요"
    echo "  sudo ./start.sh  또는  sudo LC_ALL=C node server/server.js"
    echo ""
fi

node server.js
