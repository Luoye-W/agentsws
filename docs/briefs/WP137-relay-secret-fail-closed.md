# WP137（安全修复，P0）聊天转发三种形态的密钥兜底一律改成「没有真密钥就拒绝」

worktree `../agentsws-wt/wp137-relay-secret` · 分支 `wp/137-relay-secret`（从 main 新起）。

## 问题（Fable 09-24 部署前发现）
访客令牌是 `HMAC(visitorSecret, …)`；只要 `visitorSecret` 能被外人算出来，就能伪造任意访客令牌、读别人的聊天会话。现在三种形态都有可推算的兜底：
1. **官方** `apps/cloud-worker/src/chat-relay-do.ts` `#visitorSeed()`：没配 `AGENTSWS_CHAT_RELAY_KEY` → 写死的 `'derived:agentsws-chat-relay'`（开源可见）。
2. **自建 Cloudflare 模板** `packages/chat-relay/src/standalone-worker.ts`：没配 `VISITOR_SECRET` → `derived:${hash(workspace)}:visitor`（工作区 id 写在商家网站的嵌入代码里，公开）。
3. **自建 Node / Docker** `packages/chat-relay/src/node-host.ts`：`visitorSecret` = `derive(\`${ws}:visitor\`)`——**从来没用过任何秘密**，只由工作区 id 推出。
另：离线留言封箱密钥也有常量兜底——官方 `#messageKeyOf()` 回 `'no-message-key-issued'`，Node 版 `messageKey ?? 'no-message-key'`。

## 修法
- 官方：`AGENTSWS_CHAT_RELAY_KEY` 必填且 ≥ 32 字节；没配 → 访客面一律 503 人话（「聊天窗暂时不可用」），`/v1/cloud/health` 的 relay 项标红；**不再有任何兜底**。测试注入走 options（加 `visitorSeed?`），不靠兜底。
- 自建 Cloudflare 模板：`VISITOR_SECRET` 必填；没配拒绝服务并在日志说清楚；`deploy/chat-relay/README.md` 的步骤里加上 `wrangler secret put VISITOR_SECRET`。
- 自建 Node：首次启动随机生成 32 字节服务端秘密，存进它的数据卷（与配对密钥哈希同处），**不打印**；访客密钥从它派生；老部署升级时自动补生成（已发出的访客令牌会失效，访客重新建会话即可——写进 README 的升级说明）。
- 留言封箱：没签发留言密钥就**不收留言**（回人话：「商家还没完成配对，暂时不能留言」），不再用常量封箱。
- 守卫测试：扫 `packages/chat-relay/src` 与 `apps/cloud-worker/src`，出现 `derived:` 前缀的兜底字符串、`no-message-key` 字样即失败；每种形态各一条「没有密钥 → 拒绝」的测试，一条「用工作区 id 推出的令牌不被接受」的测试。
- 文档：`docs/74` 隐私一节、`docs/64` secrets 表加 `AGENTSWS_CHAT_RELAY_KEY`（必填）、`deploy/chat-relay/README.md`。

验证：`scripts/verify-changed.sh` + `vitest run packages/chat-relay apps/cloud-worker apps/server` + `pnpm -F @agentsws/cloud-worker exec wrangler deploy --dry-run --containers-rollout=none`。
