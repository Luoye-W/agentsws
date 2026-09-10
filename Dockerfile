# agentsws 服务进程镜像（40 §1.3「公司 Docker 档」/ 41 §2.1）。
#
# 多阶段：编译阶段带完整 monorepo 与开发依赖，运行阶段**只带跑起来要的东西**——
# 服务进程的 dist、它依赖的 workspace 包的 dist、生产依赖，以及工作台的静态产物。
# 桌面壳（Electron）、模拟回路的场景包、评测集一概不进镜像。
#
# 原生模块只有一个：better-sqlite3。它在编译阶段按镜像自己的 Node ABI 装好，
# 运行阶段直接复用 node_modules，所以运行镜像里**不装编译工具链**。
# 这也是 Postgres 驱动选 `postgres`（纯 JS）而不是 `pg` 的原因之一。
#
# **两个阶段都不跑 apt**。编译阶段用完整的 `node:22-bookworm`（自带 python3 / make / g++，
# better-sqlite3 的预编译包偶尔缺平台时能就地编译）；运行阶段用 slim，健康检查用
# `node --eval` 而不是 curl。少一次 apt 就少一个「构建时 Debian 镜像站抽风」的失败点——
# 这不是假设，第一版就是在 `apt-get install curl` 上 502 挂掉的。

# ── 编译 ────────────────────────────────────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    CI=1

RUN corepack enable

# 先只拷清单，让依赖层能被缓存住
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY role-packs ./role-packs
COPY tsconfig.json tsconfig.base.json ./
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

# 服务进程 + 工作台静态产物
RUN pnpm exec tsc -b \
 && pnpm --filter @agentsws/workstation exec vite build

# 只留生产依赖（把 vitest / biome / typescript 那一坨扔掉）
RUN pnpm prune --prod --ignore-scripts

# ── 运行 ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    AGENTSWS_PORT=4317 \
    AGENTSWS_DATA_DIR=/data \
    AGENTSWS_STATIC_DIR=/app/apps/workstation/dist

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/workstation/dist ./apps/workstation/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/role-packs ./role-packs

# 数据目录挂出去：SQLite 库、blob 目录、密钥文件都在里面。
# NAS 档就是把宿主的共享目录挂到这里（见 deploy/nas/README.md）。
VOLUME ["/data"]
EXPOSE 4317

# 不用 root 跑。/data 的属主在 compose / NAS 那边给（见 README 的权限一节）。
USER node

# 用 node 自己打，不为一次健康检查往镜像里塞 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.AGENTSWS_PORT||4317}/v1/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/index.js"]
