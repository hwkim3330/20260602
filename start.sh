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

cd "$ROOT"

# Resolve the Node to use, honoring .nvmrc so the cap/sendqueue native ABI
# matches the committed prebuilds (prebuilds/<os>-<arch>/node-v<ABI>/). Using a
# different Node major changes the ABI and forces a source rebuild.
if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env 2>/dev/null)"; fnm use 2>/dev/null || true
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"; nvm use 2>/dev/null || true
fi
NODE="$(command -v node)"
[ -z "$NODE" ] && { echo "[ERROR] node not found in PATH"; exit 1; }
NODE="$(readlink -f "$NODE")"

# npm install (node_modules 없을 때) — postinstall이 필요 시 cap을 소스 빌드
if [ ! -d server/node_modules ]; then
    echo "[1/2] npm install..."
    ( cd server && npm install )
fi

echo "[2/2] Starting server..."
echo "  node: $NODE ($("$NODE" -p 'process.version+" / ABI "+process.versions.modules' 2>/dev/null))"
echo ""

# Raw packet send/capture needs CAP_NET_RAW + CAP_NET_ADMIN. Prefer file
# capabilities on the node binary over sudo: same UID + same node binary means
# the native ABI always matches the prebuilt, and no password per run. Fall back
# to sudo with the SAME node path — never bare `sudo node`, which can resolve a
# different Node version (e.g. /usr/local/bin) and break the cap.node ABI.
if [ "$(id -u)" -eq 0 ] || { command -v getcap >/dev/null 2>&1 && getcap "$NODE" 2>/dev/null | grep -qi cap_net_raw; }; then
    exec env LC_ALL=C LANG=en_US.UTF-8 "$NODE" server/server.js
fi

echo "  [INFO] raw-socket 권한이 필요합니다. 둘 중 하나:"
echo "    1) 한 번만:  sudo setcap cap_net_raw,cap_net_admin+eip \"$NODE\""
echo "                 → 이후 sudo 없이 ./start.sh 로 실행 (권장)"
echo "    2) 지금 sudo로 실행 (같은 node 바이너리 사용)"
echo ""
exec sudo env LC_ALL=C LANG=en_US.UTF-8 "$NODE" server/server.js
