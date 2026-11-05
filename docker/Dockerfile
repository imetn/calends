# Calends 自托管镜像：Worker 打成单文件，跑在一个 Node 进程里，数据是 /data 下的 SQLite 文件。
# 构建（在仓库根目录执行）：docker build -f docker/Dockerfile -t calends .
# 运行：docker run -d --restart unless-stopped -p 8787:8787 -v calends-data:/data calends
# 产物是纯 JS，与架构无关：只在构建机的架构上跑一次，arm64 不必走 QEMU。下方运行阶段不能有 RUN
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG BASE_PATH=""
RUN BASE_PATH="$BASE_PATH" npm run build && npm run build:docker

FROM node:24-bookworm-slim
WORKDIR /app
# 堆上限让占用可预期，超限时进程退出、由重启策略拉起；想调整可用 -e NODE_OPTIONS=... 覆盖
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    NODE_OPTIONS="--max-old-space-size=192 --disable-warning=ExperimentalWarning"
# 运行时只需要打包好的 Worker 和前端，不装任何 npm 依赖
COPY --from=build /app/dist ./dist
COPY --from=build /app/build/docker/entrypoint.mjs ./docker/entrypoint.mjs
VOLUME ["/data"]
EXPOSE 8787
# 用 bash 发请求，不为探活每次新起一个 Node 进程；/healthz 只查一次数据库，不进 Worker
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${PORT:-8787} && printf "GET /healthz HTTP/1.0\r\n\r\n" >&3 && head -n1 <&3 | grep -q " 200 "'
CMD ["node", "docker/entrypoint.mjs"]
