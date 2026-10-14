ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APT_MIRROR=mirrors.aliyun.com

FROM node:22-bookworm-slim AS web
ARG NPM_REGISTRY
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm config set registry ${NPM_REGISTRY} \
 && npm ci --registry=${NPM_REGISTRY}
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim
ARG NPM_REGISTRY
ARG APT_MIRROR
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PS5WATCH_HOST=0.0.0.0 \
    PS5WATCH_PORT=5175 \
    PS5WATCH_STATE_DIR=/data/state \
    PS5WATCH_BDUSS_FILE=/data/bduss.txt
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry ${NPM_REGISTRY} \
 && npm ci --omit=dev --registry=${NPM_REGISTRY}
COPY server/ ./server/
COPY ps5watch.mjs config.json ./
COPY --from=web /app/web/dist ./web/dist
VOLUME /data
EXPOSE 5175
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:5175/ >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "server/index.mjs"]
