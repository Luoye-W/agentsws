# Agents 工坊 · 聊天转发器（自建 Docker 档，WP124 / docs/74）
#
# 转发器只转发：不存对话正文、不跑 AI。这条镜像里没有你的任何业务数据；
# 卷上落的是配对哈希、对话计数与留言密文。
#
# 构建在仓库根目录跑：docker build -f deploy/chat-relay/Dockerfile -t agentsws-chat-relay .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# build chat-relay 与它的依赖（contracts 等）
RUN pnpm install --frozen-lockfile && pnpm --filter @agentsws/chat-relay... build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/chat-relay/node_modules ./packages/chat-relay/node_modules
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/chat-relay/dist ./packages/chat-relay/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/chat-relay/package.json ./packages/chat-relay/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
ENV NODE_ENV=production
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "packages/chat-relay/dist/cli.js"]
