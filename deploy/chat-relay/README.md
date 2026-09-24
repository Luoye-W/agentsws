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
   （还有一把「服务端秘密」是转发器自己随机生成、存在卷里的，**不打印、你也不用管它**——
   访客的会话凭据由它派生，外人拿不到它就伪造不了。别把卷目录分享给别人。）

4. **填回工作台**：Agents 工坊 → 客服 → 网站在线客服 → 聊天窗 → 转发方式，
   选「自建」，地址填 `http://这台机器的IP:8787/relay/ws_你的工作区号`，
   粘贴配对密钥，保存，点「测试连接」。

5. **要 HTTPS**（建议：浏览器对非 HTTPS 页面会挡 ws://）：
   - 给这台机器指一个域名（DNS A 记录）；
   - `docker compose -f deploy/chat-relay/docker-compose.yml --profile caddy up -d`
   - 改 `deploy/chat-relay/Caddyfile` 里的域名为你自己的，重启 caddy。
   - 证书自动签发，地址填 `https://你的域名/relay/ws_你的工作区号`。

**从旧版升级（2026-09-24 之前起的服务）**：照常拉新代码、`up -d --build` 即可。
转发器第一次启动会自动在卷里补一把服务端秘密（WP137 安全修复：旧版访客凭据是按工作区号
推出来的，外人也推得出来）。影响只有一条：**升级那一刻正开着的访客对话要重新建**——
访客刷新一下网页就好，你这边的对话记录一条不丢。
如果你的服务是很早（还没有「留言密钥」那一版）起的，升级后会**暂时不收离线留言**
（访客看到「现在还不能留言」）；想要留言功能：停服务、删掉卷目录、重新 `up`，
拿新打印的配对密钥与留言密钥重新填回工作台。

## 路 B：Cloudflare Worker（有自己的 Cloudflare 账号）

1. 装一次 Wrangler：`npm install -g wrangler`，然后 `wrangler login`。
2. `deploy/chat-relay/worker/` 目录里：
   - 把 `wrangler.toml` 里的 `WORKSPACE` 改成你的工作区号；
   - `wrangler secret put PAIRING_TOKEN`，值自己生成：`openssl rand -base64 32`；
   - `wrangler secret put VISITOR_SECRET`（**必填**），**再生成一把不一样的**：`openssl rand -base64 32`。
     它是访客会话凭据的钥匙，只留在 Cloudflare 里，不用填到任何别的地方。
     没配（或短于 32 个字符）转发器会**整台拒绝服务**（聊天窗打不开），
     `wrangler tail` 里能看到一句提示；补上后不用重新部署；
   - 想收离线留言：`wrangler secret put MESSAGE_KEY`（选填，同样 `openssl rand -base64 32` 生成），
     **同一把**填进工作台聊天窗设置的「留言密钥」。不配就不收留言（访客看到「现在还不能留言」）；
   - `wrangler deploy`。
3. 地址是 `https://agentsws-chat-relay.<你的子域>.workers.dev/relay/ws_你的工作区号`，
   配对密钥就是刚才那把 `PAIRING_TOKEN`，填进聊天窗设置。

**从旧版升级**：旧版 `VISITOR_SECRET` 是选填的，没配时会用一把外人也推得出来的钥匙
（WP137 修掉的安全问题）。升级前先 `wrangler secret put VISITOR_SECRET`，再 `wrangler deploy`；
正开着的访客对话要重新建（访客刷新网页即可）。

注意：这一档是**内存态**——重新部署会丢还没拉走的留言密文。要长期用，
选 Docker 档或官方托管。

---

## 常见问题

**「测试连接」不过 / 聊天窗打不开？**
- Worker 档：先确认配了 `VISITOR_SECRET`（`wrangler secret list`），没配整台都是 503。
- 地址末尾要带 `/relay/<工作区号>`；不是只有域名。
- 本机那侧也要填了同一把配对密钥（工作台的设置里），本机显示「在线」才算通。
- 浏览器挡 `ws://`：走 HTTPS（路 A 的 Caddy，或路 B 自带 HTTPS）。

**重启会丢什么？**
对话记录、AI、知识全在你电脑上，不受影响；转发器丢的只有「还没拉走的留言」
（Docker 档有卷不丢；Worker 档会丢）和当分钟的限流计数。

**上限？** 自建无上限。官方托管免费档每月 200 个对话（到 80% 提醒）；
订阅客服增值服务后也不受限。
