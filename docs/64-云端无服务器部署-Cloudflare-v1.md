# 64 · 云端无服务器部署 v1（Cloudflare Workers，官方托管那一份）

| | |
|---|---|
| 状态 | **WP114 实现**（2026-09-18）。这一版是**内测环境**：不开 Stripe、额度手动发、在线值守与公共红人库不在这里 |
| 起因 | 不想为云端另买一台服务器。手里有 Cloudflare（`agentsws.com` 就是在它这里注册的，DNS 也在），那就把云端跑成一个 Worker |
| 关联 | 49（统一账号、服务入口与积分：M1–M6）、**61（Compose 自建形态——留给开源自建用户，两份都在）**、21（数据驻留与密钥纪律）、34（仓库结构）、`apps/cloud-worker/`（这一版的全部配置） |

## 0. 一句话

**一个 Worker、两类 Durable Object、一条 `wrangler deploy`。** 没有服务器、没有 Docker、没有 SSH、没有证书要续。装完之后内测朋友在自己电脑上的 Agents 工坊里点一次「关联账号」，收一封信，就能用积分跑模型。

这篇是**给非运维看的**。每一步都写了"为什么"与"没做对会怎样"。你需要会用终端敲命令，其余不需要懂。

> **两份部署形态，都留着。** 这一篇是**官方托管**（`cloud.agentsws.com` 跑的那一份）。
> `docs/61` 是 **Compose 自建形态**——开源用户想自己搭一台就照那一篇，那边有
> New API、在线值守、公共红人库，功能更全但要一台服务器。两边跑的是**同一份
> 路由表与同一段鉴权代码**（`@agentsws/cloud` 的 `buildCloudApp`），所以行为一致
> 不是靠对齐，是因为根本只有一份。

---

## 1. 为什么是 Durable Objects（这一条决定了后面所有事）

云端有一样东西是全仓库最不能出错的：**钱**。

`packages/metering/src/wallet.ts` 开头那行注释写着一条刻意的纪律——存储口**全同步**，"钱的读写要么成要么不成，中间不该有一个 await 让别的请求插进来"。预扣（reserve）与结算（settle）之间只要有一个 await，两条并发请求就能读到同一个余额，各自以为钱够。

于是选平台这件事变成了一个很窄的问题：**哪一个云上的数据库是同步的？**

| 选项 | 同步？ | 结论 |
|---|---|---|
| Supabase（Postgres） | 异步 | ✗ 用它就得把钱包与账号库整片改成 `async`——而那正是把并发扣款的窗口打开 |
| Cloudflare D1 | 异步 | ✗ 同上 |
| **Cloudflare Durable Objects（SQLite 后端）** | **同步**（`ctx.storage.sql.exec` 是同步 SQL），而且**单对象单线程** | ✓ 现有的同步存储口原样成立，一行业务代码都不用改 |

所以：**账号库与钱包放 Durable Objects，不放 Supabase / D1。** Supabase 这一轮完全不用。

这个取舍的代价要说清楚：DO 的库不能用标准的 Postgres 工具连上去看、没有现成的 BI、单个对象有 10 GB 上限。换来的是"钱的那条纪律在云上原样成立"。我们认为这笔买卖划算——**余额算错一次，比查数据不方便一年更贵**。看数与搬家那条路见 §9。

## 2. 架构一图（文字版）

```
                 浏览器 / 本地 Agents 工坊
                          │  https://cloud.agentsws.com
                          ▼
               ┌──────────────────────────┐
               │      入口 Worker         │  ← 不存任何东西
               │  ① 剥掉外面塞的内部头     │
               │  ② 验令牌（每次都问）     │
               │  ③ 选对象  ④ 原样转（流式不缓冲）│
               └────────┬─────────┬───────┘
                        │         │
        ┌───────────────┘         └───────────────┐
        ▼                                         ▼
┌────────────────────┐                ┌──────────────────────────┐
│   AccountsDO（单例）│                │  WalletDO（每个组织一个） │
│  账号 / 组织 / 成员 │  ←─ 导出时问 ─→ │  积分批次 / 预扣          │
│  magic link / 会话  │   /__internal/ │  计量事件（只有八列）      │
│  工作区服务令牌      │      lots      │  /v1/ai/* 转发与结算      │
│  限流 / 幂等        │                │  /v1/wallet/*             │
│  首页 / 登录落地页   │                │  /v1/admin/topup          │
│  /v1/admin/export   │                │  alarm：扫孤儿预扣         │
└────────────────────┘                └──────────────────────────┘
        │                                         │
        │ 发信（Email Sending binding，无密钥）      │ 模型上游（OpenAI 兼容口）
        ▼                                         ▼
    login@agentsws.com                    api.deepseek.com/v1（内测期）
```

三件事值得单独记住：

1. **钱包每个组织一个对象**（`idFromName(org_id)`）。一个组织的钱全在自己那一个对象里、单线程，所以扣款没有并发窗口；组织之间互不阻塞——A 在跑一条长流式，B 查余额照样是毫秒。
2. **令牌每次都去问 `AccountsDO`，一秒都不缓存。** 所以"撤销立刻生效"是真的立刻。代价是每个 `/v1/ai` 请求多一跳（同机房内，通常几毫秒）。
3. **内部头进门先剥。** Worker 把已验证的 principal 放在 `X-Agentsws-Internal-Principal` 里交给 DO；外面任何人自己塞一个同名头，会在进门第一行被删掉。不剥的话，伪造这个头就等于伪造任意组织的身份。

---

## 3. 先准备什么

| 项 | 要什么 | 为什么 |
|---|---|---|
| Cloudflare 账号 | 就是 `agentsws.com` 那个（域名在这里注册、DNS 也在） | 自定义域一步到位：不用改 NS，也不用去后台点 |
| **Workers Paid** | **$5 / 月起** | 两件事都要它：① Durable Objects 的 SQLite 后端；② Email Sending **发给任意收件人**（免费档只能发给自己账号里已验证的地址——内测朋友的邮箱不在里面） |
| 一台能敲命令的电脑 | Node ≥ 22、pnpm ≥ 10 | `wrangler` 从这台机器上传代码 |
| 模型上游 | 一家 OpenAI 兼容口的 key | 内测期直接指 DeepSeek 官方（`https://api.deepseek.com/v1`）。**这一版不带 New API**——那是 Compose 形态的东西 |

不需要：服务器、Docker、SSH、证书、备案、Nginx / Caddy。

> **Email Sending 的可用性**：这是 Cloudflare 2025 年推出的服务，本文按 2026-09 的官方
> 文档写（`developers.cloudflare.com/email-service/`）。当时的口径是：Workers Paid 档
> 每月含 3,000 封，超出 $0.35 / 1,000 封；发给本账号已验证的目的地址免费且不计额度；
> 单封收件人合计 ≤ 50、整封 ≤ 5 MiB。**如果你打开后台发现它还要申请 / 排队**，
> 那就先走 §11 的退路（Compose 形态的 SMTP），不要为了绕开它去硬编码什么。

---

## 4. 逐步装（第一次）

下面每一步都在**你自己的电脑上**、在仓库根目录敲。密钥一律由你自己敲，**不要贴给任何人、也不要写进仓库**。

### ① 登录 Cloudflare

```sh
pnpm -F @agentsws/cloud-worker exec wrangler login
```

浏览器会弹出来让你授权。授权完终端里会说 `Successfully logged in`。

> 这一步**只有你能做**，而且只做一次。它把一份凭据写进你自己电脑的
> `~/.wrangler/`，不进仓库。

### ② 先空跑一次，确认打得出包

```sh
pnpm -F @agentsws/cloud-worker exec wrangler deploy --dry-run
```

它会打包但**不上传**，最后打印一行 `Total Upload: … / gzip: …`。看到它就说明代码是好的。这一步不需要登录，随时可以跑（CI 里跑的也是它）。

### ③ 真的部署

```sh
pnpm -F @agentsws/cloud-worker exec wrangler deploy
```

第一次会多做两件事，都会在终端里问你或者直接告诉你：

- 建两个 Durable Object 命名空间（`AccountsDO` / `WalletDO`）并跑 `migrations` 里那条 `new_sqlite_classes`；
- 按 `wrangler.toml` 里的 `routes` 建自定义域 **`cloud.agentsws.com`**，并自动加好 DNS 与证书。

> 域名本来就在这个账号里，所以这一条是**自动**的——不用去后台点「Add domain」、
> 不用改 NS、不用等 DNS 生效、不用申请证书。这也是 WP114 选 Cloudflare 的第二个理由。

部署完打开 <https://cloud.agentsws.com/v1/cloud/health>，应该看到一段 JSON。这时 `mail` 那一格是 `false`——下一步就是它。

### ④ 把发信打通（Email Sending）

先在 Cloudflare 后台或者命令行给 `agentsws.com` 开通发信：

```sh
pnpm -F @agentsws/cloud-worker exec wrangler email sending enable agentsws.com
pnpm -F @agentsws/cloud-worker exec wrangler email sending dns get agentsws.com   # 核对记录
```

或者后台：**Compute & AI → Email Service → Email Sending → Onboard Domain**，选 `agentsws.com`，点 **Add records and onboard**。

它会自动往 DNS 里加 **SPF（TXT）** 与 **DKIM（CNAME 或 TXT）**。域名就在这个账号里，所以这一步是一键——**你不用手抄任何一条记录**。通常 5–15 分钟生效。

> **DMARC 建议自己再加一条**（它不是自动加的，但没有它很多收件方会把信丢进垃圾箱）：
>
> | 类型 | 名称 | 值 |
> |---|---|---|
> | `TXT` | `_dmarc` | `v=DMARC1; p=none; rua=mailto:你自己的一个邮箱` |
>
> `p=none` 是"只观察不拦截"，内测期用它；等稳定了再收紧成 `quarantine`。

发件地址 `Agents 工坊 <login@agentsws.com>` 已经写在 `wrangler.toml` 的 `[vars]` 里（**它不是密钥**，所以进仓库）。要换名字改那一行再 deploy 一次就行。

### ⑤ 逐个填密钥

**一条一条敲，每敲一条它会提示你粘贴值，粘完回车。** 值不回显、不进仓库、不进日志。

```sh
cd apps/cloud-worker
npx wrangler secret put AGENTSWS_NEWAPI_KEY
npx wrangler secret put AGENTSWS_CLOUD_ADMIN_TOKEN
```

**全表**（仓库里只有名字，没有值）：

| 名字 | 是什么 / 去哪儿拿 | 必填？ | 不填会怎样 |
|---|---|---|---|
| `AGENTSWS_NEWAPI_KEY` | 模型上游那把 key。内测期就是 DeepSeek 官网 → API Keys 里新建的那一串 | **必填** | `/v1/ai/*` 一律 500，跑不了模型 |
| `AGENTSWS_CLOUD_ADMIN_TOKEN` | 你自己生成一串：`openssl rand -base64 48`。**至少 32 字节**，短了会拒绝启动 | **必填**（内测期要靠它发积分） | `/v1/admin/topup` 与 `/v1/admin/export` **根本不存在**（404，不是 401）——发不了额度，也导不出备份 |
| `STRIPE_SECRET_KEY` | Stripe 后台 → Developers → API keys | 选填 | 用户点"充值"回 501 一句人话（这就是内测期的现状） |
| `STRIPE_WEBHOOK_SECRET` | Stripe 后台 → Developers → Webhooks → 建一个指向 `https://cloud.agentsws.com/v1/wallet/topup/stripe/webhook`，把 `whsec_…` 抄下来 | 选填 | 同上；配了 secret key 却不配它，webhook 一律 501 |

**没有发信的密钥**——Email Sending 在 Worker 里是一个 binding，一把 key 都不用。这是这个形态相对 SMTP 的一个实际好处：少一处"放哪儿、谁看得见、多久轮换"。

非密钥的那几项在 `wrangler.toml` 的 `[vars]` 里，改完 deploy 一次生效：

| 名字 | 现在的值 | 什么时候改 |
|---|---|---|
| `AGENTSWS_CLOUD_BASE_URL` | `https://cloud.agentsws.com` | 换域名时。**信里那条链接指着它**，改错了等于所有人登不进来 |
| `AGENTSWS_CLOUD_PUBLIC_URL` | 同上 | 支付完跳回哪儿 |
| `AGENTSWS_CLOUD_MAIL_FROM` | `Agents 工坊 <login@agentsws.com>` | 换发件人显示名或地址时（地址必须在已开通发信的域上） |
| `AGENTSWS_NEWAPI_BASE_URL` | `https://api.deepseek.com/v1` | 以后换回自建的 New API，只改这一行 |
| `AGENTSWS_VERSION` | `0.1.0` | 想让 health 与首页显示别的版本号时 |

填完再 deploy 一次（secret 是立刻生效的，但顺手确认一下）：

```sh
pnpm -F @agentsws/cloud-worker exec wrangler deploy
```

### ⑥ 冒烟

```sh
./deploy/smoke.sh https://cloud.agentsws.com
```

它只用**公开**路由，不需要任何密钥，所以从你自己的笔记本上跑就行。

要连发信一起验（最容易出问题的就是这一步），给一个**你自己收得到**的地址：

```sh
SMOKE_EMAIL=me@example.com ./deploy/smoke.sh https://cloud.agentsws.com
```

那会真发一封信。限流是每邮箱 5 次 / 小时，别连着跑六遍。

> 冒烟里 `standby` 与 `kol_public` 会显示"没开通"，**那是对的**（见 §10），
> 脚本也不把它算作失败——两个部署形态用同一个冒烟脚本。

### ⑦ 给内测朋友发积分

让他先在自己电脑上的 Agents 工坊里关联一次账号（设置 → 账号与积分 → 关联），收信、点链接。**关联过之后**他的邮箱才在库里，才发得了积分：

```sh
curl -X POST https://cloud.agentsws.com/v1/admin/topup \
  -H "Authorization: Bearer <你刚才那串 ADMIN_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"email":"friend@example.com","credits":200,"expires_in_days":90}'
```

回 201 就发好了。发的是 **`granted`** 那一类积分（90 天到期清零），不是"永不过期的钱"——内测送的额度不该变成负债。同一条命令重复发会发两笔；要防重就带一个 `"source_ref":"内测第一批-friend"`，同一个 `source_ref` 只入一次。

> 这条命令里有你的 admin token。**别把它贴进任何聊天窗口或 issue。**
> 想留个记录，把 token 换成 `<ADMIN_TOKEN>` 再贴。

---

## 5. 升级

```sh
git pull
pnpm install
pnpm -F @agentsws/cloud-worker exec wrangler deploy
```

**就这一条。** 不用停机，不用手动跑迁移。

数据库迁移是这么发生的：每个 Durable Object 在**第一次被唤醒**时跑自己的构造函数，构造函数里同步把缺的版本补上（`_migrations` 表记录跑到哪一版）。所以新版本上去之后，某个组织下一次有请求，它那个 `WalletDO` 醒来就顺手迁移了；一年没人用的组织就一直没迁——没关系，它醒来的那一刻才需要新表。

三件要记住的事：

1. **迁移必须是"加"不是"改"**。加表、加列、加索引都行；删列 / 改类型不行——老对象与新对象会在同一时刻分别存在（一个已经醒过，一个还没）。
2. 迁移是同步的，所以它**不能很慢**。我们这几张表都是建表加索引，毫秒级。
3. `wrangler.toml` 里的 `[[migrations]] tag = "v1"` 是**另一件事**——那是 Cloudflare 的"这个类用 SQLite 后端"的声明，不是我们的表结构版本。加新的 DO 类时才动它。

## 6. 回滚

```sh
pnpm -F @agentsws/cloud-worker exec wrangler rollback
```

它把 Worker 的代码退回上一个版本（会让你确认）。要退到更早的某一版，先看列表：

```sh
pnpm -F @agentsws/cloud-worker exec wrangler deployments list
pnpm -F @agentsws/cloud-worker exec wrangler rollback <版本 id>
```

**注意**：回滚的是**代码**，不是**数据**。已经跑过的迁移不会撤销。所以上一条"迁移只加不改"不只是洁癖——它是回滚能安全工作的前提。数据要回退见 §9 的 PITR。

## 7. 费用预估

| 项 | 计价 | 内测期大概是多少 |
|---|---|---|
| Workers Paid | **$5 / 月起**（含 1,000 万次请求、3,000 万 CPU 毫秒） | $5。内测十来个人根本用不到含量的零头 |
| Durable Objects 请求 | 按请求数计，含在 Paid 的额度里一大块 | ≈ $0 |
| DO SQLite **存储** | 按 GB-月 计（2026-01 起开始计费） | 账号与积分批次是纯文本小表，十来个人几 MB，≈ $0 |
| DO SQLite **读 / 写行数** | 按百万行计 | 我们每个请求读写个位数行，≈ $0 |
| Email Sending | Paid 档含 3,000 封 / 月，超出 $0.35 / 1,000 封 | 内测期几十封，$0 |
| 自定义域 / 证书 / DNS | 免费 | $0 |
| **模型上游** | DeepSeek 按 token 计，**这一笔不在 Cloudflare 账上** | 看用量。这才是真正会花钱的那一项 |

**结论：基础设施 $5 / 月封顶，剩下全是模型钱。** 对比 Compose 形态那台 2 核 4G（大约 $20–40 / 月）便宜，而且没有一台需要打补丁的机器。

> 真要省那 $5：技术上 Workers 免费档也能跑，但 ① DO 的 SQLite 要 Paid；
> ② Email Sending 发给任意收件人要 Paid。两条都绕不开，所以 $5 是这个形态的门槛。

## 8. 出问题先看哪儿

| 现象 | 先看 | 多半是什么 |
|---|---|---|
| 打开 `cloud.agentsws.com` 是 Cloudflare 的错误页 | `wrangler deployments list` | 没 deploy 成功，或者自定义域没建起来 |
| health 里 `mail: false` | `wrangler email sending dns get agentsws.com` | 发信域没开通，或者 SPF / DKIM 还没生效 |
| 发信 503「登录信没发出去」 | `wrangler tail` 实时日志 | 看那一行的 `code=E_…`：`E_SENDER_NOT_VERIFIED` = 域没开通；`E_DAILY_LIMIT_EXCEEDED` = 额度满了 |
| `/v1/ai/*` 回 500「没有配上游密钥」 | `wrangler secret list` | `AGENTSWS_NEWAPI_KEY` 没填 |
| `/v1/admin/topup` 回 404 | `wrangler secret list` | `AGENTSWS_CLOUD_ADMIN_TOKEN` 没填——**没配这条路由根本不挂**，这是有意的 |
| 用户说"积分不够"但看着有余额 | `GET /v1/wallet`（带他的令牌）看 `reserved` | 有孤儿预扣占着。正常情况下 `WalletDO` 的闹钟每 10 分钟会扫掉超过 1 小时的那些 |
| 想看实时日志 | `pnpm -F @agentsws/cloud-worker exec wrangler tail` | 日志里**没有令牌、没有完整邮箱**（只有域名）——这是纪律，不是漏打 |

## 9. 备份、看数、搬家

**两条路，各管一件事。**

### 9.1 出事回退：PITR（Cloudflare 自己的）

Durable Objects 的 SQLite 有 **30 天的时间点恢复（Point-in-Time Recovery）**：可以把某一个对象恢复到过去 30 天里的任意一刻。这一条不需要你做任何配置——它是自带的。

用它的场合：**误删、迁移写坏了、某个组织的账被改乱了**。恢复是按对象粒度的（比如只恢复某一个组织的 `WalletDO`）。

用不了它的场合：**Cloudflare 这个账号本身没了**。所以还要下面这条。

### 9.2 跑路与搬家：`GET /v1/admin/export`

```sh
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://cloud.agentsws.com/v1/admin/export > snapshot-$(date +%F).json
```

里面是：账号（邮箱）、组织、成员、工作区关联（**带令牌哈希，不带明文**——明文库里本来就没存过）、每个组织的积分批次。

**不在里面的**：一次性登录与会话（它们只活几分钟到十几小时，搬家时让人重登一次比搬会话干净）、计量事件（那是流水账，动辄几十万条；搬家要搬的是余额不是历史）。

这一份 JSON 是**两个部署形态之间唯一的共同货币**：Workers 的库在 DO 里，Compose 的库是几个 sqlite 文件，没有"把文件拷过去"这个动作。有了它，将来从 Workers 搬回 Compose、或者反过来，都有路可走。

建议：**每周跑一次，存在你自己的机器上**（它不大）。里面有内测用户的邮箱，按个人信息对待——别丢进公开的地方。

### 9.3 想看数怎么办

DO 的库连不上标准 SQL 客户端，这是 §1 那个取舍的代价。这一版的办法就是 `GET /v1/admin/export` 拉下来自己看。将来要看板，正路是**把计量事件另外抄一份到一个能查的地方**（Analytics Engine 或者一张 D1 表）——那是"只读的副本"，不是第二本账，所以它异步无所谓。

## 10. 在线值守为什么不在这里，公共红人库为什么也不在

### 10.1 在线值守（`packages/standby`）

它要给每个开通的工作区起一个**常驻的 Node 子进程**。Workers 上没有这种东西——Worker 是请求来了才跑、跑完就走的。

所以这一轮 Workers 形态**不挂它**，`/v1/cloud/health` 里 `standby: false`，**如实说没开通**，不假装有。想用在线值守的，走 `docs/61` 的 Compose 形态。

将来两条路，各有代价：

| 路 | 怎么做 | 代价 |
|---|---|---|
| **Cloudflare Containers** | Cloudflare 自己的容器产品，能跑常驻进程，且与 Worker / DO 在同一个账号同一套绑定里 | 比 Worker 贵，而且要把子进程编排那一套（`packages/standby`）改成"起容器"而不是"起子进程" |
| **一台小机器** | 就是 `docs/61` 那台，只跑值守；账号与钱还在 Workers 这边，它拿一把内部令牌来用 `/v1/ai/*` | 又有一台要打补丁的机器，但改动最小——值守那一套代码一个字不用动 |

### 10.2 公共红人库（`packages/kol-public`）

技术原因很具体：它的服务同时要**一张全局共享的红人表**和**某个组织的钱包**，而且是在**同一个同步上下文**里（查一次要扣一次积分）。Workers 形态下这两样在两个不同的 Durable Object 里——把它们凑到一起，只能让钱包那一侧变成异步，那正是 §1 要躲的东西。

将来的正路是把它改成**两段式**：先在 `WalletDO` 里预扣，再去公共库那个对象取数，回来结算或释放。这与 `/v1/ai/*` 现在的做法是同一个形状，改动量不大但不在这一轮。同样地，health 里 `kol_public: false`，不假装有。

## 11. 这一版没做的

1. **一次真部署都没跑过**（WP114 只跑到 `wrangler deploy --dry-run`）。真实的 DO 运行时上有几件只有跑一次才知道的事，见 WP114 报告第 5 节。
2. **Stripe 仍是 501**，微信 / 支付宝也是。额度走 `POST /v1/admin/topup` 手动发。
3. **没有监控与告警**。挂了没人主动说，只能自己跑 `deploy/smoke.sh`，或者在 Cloudflare 后台看 Worker 的错误率。
4. **没有网页控制台**。`/login` 只回答"这条链接有效"，不发会话 token——本地关联走的是回环回调。
5. **导出要手动跑**（没有定时备份）。PITR 是自带的，但它救不了"账号没了"。
6. **单个 DO 有 10 GB 上限**。账号库是全局单例，十万个账号也远没到；到那一天要把它按字母或哈希分片。
7. **日志只有 `wrangler tail` 的实时流**（没接 Logpush）。要留存历史日志得另配。

## 12. 文件在哪儿

| 文件 | 是什么 |
|---|---|
| `apps/cloud-worker/wrangler.toml` | 全部配置。**一个密钥都没有**——`[vars]` 只放非敏感项 |
| `apps/cloud-worker/.dev.vars.example` | 本地 `wrangler dev` 的密钥占位，**全是空值** |
| `apps/cloud-worker/src/worker.ts` | 入口：擦头、验令牌、选对象、转发 |
| `apps/cloud-worker/src/accounts-do.ts` | 账号那一层的 DO |
| `apps/cloud-worker/src/wallet-do.ts` | 钱包 DO（每个组织一个）+ 闹钟 |
| `apps/cloud-worker/src/do-sql.ts` | DO 的 SQL → 同步 SQL 口（`SyncDb`） |
| `apps/cloud/src/app.ts` | **两个形态共用**的路由表与鉴权装配 |
| `deploy/smoke.sh` | 冒烟（两个形态共用） |
| `docs/61-…` | **Compose 自建形态**的 runbook（留给开源自建用户） |
