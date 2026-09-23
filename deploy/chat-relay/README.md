# 自建聊天转发器 · 给非运维的逐步说明（WP124 / docs/74）

转发器的职责只有**转发**：访客的聊天消息从它过一手，送到你电脑上的 Agents 工坊；
AI 的回答原路送回访客。它**不存对话正文、不跑 AI**——替你存的东西只有配对密钥的
哈希、对话计数和留言密文（密文 = 没有钥匙读不懂的内容）。

三条路任选其一，**挂件与嵌入代码不用改**，切档 = 换转发器地址与密钥：

| 路 | 适合谁 | 上限 | 数据在哪 |
|---|---|---|---|
| 官方托管（免费） | 大多数人 | 每月 200 个对话 | 我们的服务器（只过路 + 计数） |
| 自建（本文档） | 想完全自己掌握、或不想要上限 | 无上限 | 你自己的服务器 |
| 客服增值服务（30 积分/月） | 电脑经常关机，想让 AI 全天值守 | 无上限 | 托管实例（同一份软件） |

---

## 路 A：Docker（推荐，一条命令）

前提：一台能开机联网的机器（云主机、NAS、家里的小主机都行），装好 Docker。

1. **拿到代码**：下载 Agents 工坊的代码包，解压（比如放在 `~/agentsws`）。

2. **起服务**（在代码目录里）：

   ```bash
   WORKSPACE=ws_你的工作区号 docker compose -f deploy/chat-relay/docker-compose.yml up -d --build
   ```

   工作区号在 Agents 工坊 → 设置里能看到。

3. **拿配对密钥**（只显示这一次）：

   ```bash
   docker compose -f deploy/chat-relay/docker-compose.yml logs chat-relay
   ```

   日志里有一块「配对密钥 / 留言密钥」，抄下来。

4. **填回工作台**：Agents 工坊 → 客服 → 网站在线客服 → 聊天窗 → 转发方式，
   选「自建」，地址填 `http://这台机器的IP:8787/relay/ws_你的工作区号`，
   粘贴配对密钥，保存，点「测试连接」。

5. **要 HTTPS**（建议：浏览器对非 HTTPS 页面会挡 ws://）：
   - 给这台机器指一个域名（DNS A 记录）；
   - `docker compose -f deploy/chat-relay/docker-compose.yml --profile caddy up -d`
   - 改 `deploy/chat-relay/Caddyfile` 里的域名为你自己的，重启 caddy。
   - 证书自动签发，地址填 `https://你的域名/relay/ws_你的工作区号`。

## 路 B：Cloudflare Worker（有自己的 Cloudflare 账号）

1. 装一次 Wrangler：`npm install -g wrangler`，然后 `wrangler login`。
2. `deploy/chat-relay/worker/` 目录里：
   - 把 `wrangler.toml` 里的 `WORKSPACE` 改成你的工作区号；
   - `wrangler secret put PAIRING_TOKEN`，值自己生成：`openssl rand -base64 32`；
   - `wrangler deploy`。
3. 地址是 `https://agentsws-chat-relay.<你的子域>.workers.dev/relay/ws_你的工作区号`，
   配对密钥就是刚才那把 `PAIRING_TOKEN`，填进聊天窗设置。

注意：这一档是**内存态**——重新部署会丢还没拉走的留言密文。要长期用，
选 Docker 档或官方托管。

---

## 常见问题

**「测试连接」不过？**
- 地址末尾要带 `/relay/<工作区号>`；不是只有域名。
- 本机那侧也要填了同一把配对密钥（工作台的设置里），本机显示「在线」才算通。
- 浏览器挡 `ws://`：走 HTTPS（路 A 的 Caddy，或路 B 自带 HTTPS）。

**重启会丢什么？**
对话记录、AI、知识全在你电脑上，不受影响；转发器丢的只有「还没拉走的留言」
（Docker 档有卷不丢；Worker 档会丢）和当分钟的限流计数。

**上限？** 自建无上限。官方托管免费档每月 200 个对话（到 80% 提醒）；
订阅客服增值服务后也不受限。
