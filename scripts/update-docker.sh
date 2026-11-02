#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--no-pull" ]]; then
  shift
else
  git pull
fi

if [[ ! -d web/node_modules ]] || [[ ! -x web/node_modules/.bin/vite ]]; then
  echo "安装前端依赖…"
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy npm ci --prefix web --no-audit --no-fund
fi

echo "构建前端…"
# 镜像站需直连；全局 HTTPS_PROXY 会导致 npm 403/卡死
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy npm run build

if docker compose ps -q pan-shelf 2>/dev/null | grep -q .; then
  echo "重启 pan-shelf 容器…"
  docker compose restart pan-shelf
else
  echo "启动容器（不重建镜像）…"
  docker compose up -d
fi

echo "网站已更新。"
