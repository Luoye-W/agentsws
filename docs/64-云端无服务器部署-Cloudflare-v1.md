# 64 · 云端无服务器部署 v1（Cloudflare Workers，官方托管那一份）

| | |
|---|---|
| 状态 | **WP114 实现**（2026-09-18）；**WP116 把公共红人库补上**（2026-09-19，见 §10.2）。这一版是**内测环境**：不开 Stripe、额度手动发、在线值守仍不在这里 |
| 起因 | 不想为云端另买一台服务器。手里有 Cloudflare（`agentsws.com` 就是在它这里注册的，DNS 也在），那就把云端跑成一个 Worker |
| 关联 | 49（统一账号、服务入口与积分：M1–M6）、**61（Compose 自建形态——留给开源自建用户，两份都在）**、21（数据驻留与密钥纪律）、34（仓库结构）、`apps/cloud-worker/`（这一版的全部配置） |

> **运营后台在 `docs/65`**（WP115）。这个形态下它多一个单例 Durable Object
> （`LedgerDO`，计量事件的只读副本——DO 按组织切开之后没有跨组织的表），
> 静态产物走 wrangler 的 `[assets]` + `run_worker_first = ["/admin/*"]`。
> **`wrangler deploy` 之前先 `pnpm --filter @agentsws/cloud-admin build`**：
> `[assets] directory` 指着 `apps/cloud-admin/dist`，它不存在 deploy 会失败。


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
| `AGENTSWS_KOL_EMAIL_KEY` | 公共红人库的邮箱密钥（WP116）。本机生成 32 字节：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`。**丢了就解不开已经落库的密文**，存进密码管理器 | 选填（要用公共红人库就必填） | **不存邮箱**（一个字节都不写，绝不降级成明文）；搬家时联系方式那一类全部 `skipped` |
| `AGENTSWS_YOUTUBE_API_KEY` | Google Cloud Console → YouTube Data API v3 | 选填 | 没有官方口，`refresh` 只能走 Apify 或"只查库" |
| `APIFY_TOKEN` | Apify 控制台 | 选填 | 没有降级口 |
| `AGENTSWS_HOSTED_KEY_SEED` | 客服增值服务托管实例的库密钥种子（WP128，§13）。本机生成 32 字节：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`。**丢了就读不回已有的快照**，存进密码管理器 | 选填（要开客服增值服务就必填） | 订阅照常扣费、转发照常，但**不起容器**（后台那一格写明原因）——电脑关了没人接 |

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

> 冒烟里 `standby` 会显示"没开通"，**那是对的**（见 §10.1），脚本也不把它
> 算作失败——两个部署形态用同一个冒烟脚本。`kol_public` 从 WP116 起跟着
> `KOL_PUBLIC` 这个 binding 走：deploy 过一次就是 true。

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
| **客服增值服务的容器**（WP128） | Containers 按秒：内存与盘按规格、CPU 按实用 | **每个订阅的工作区** basic 常驻约 $8.5 / 月、lite 约 $2.3 / 月，见 §13.3。没人订阅就是 $0 |

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

## 10. 在线值守为什么不在这里；公共红人库怎么补上的

### 10.1 在线值守（`packages/standby`）

它要给每个开通的工作区起一个**常驻的 Node 子进程**。Workers 上没有这种东西——Worker 是请求来了才跑、跑完就走的。

所以这一轮 Workers 形态**不挂它**，`/v1/cloud/health` 里 `standby: false`，**如实说没开通**，不假装有。想用在线值守的，走 `docs/61` 的 Compose 形态。

将来两条路，各有代价：

| 路 | 怎么做 | 代价 |
|---|---|---|
| **Cloudflare Containers** | Cloudflare 自己的容器产品，能跑常驻进程，且与 Worker / DO 在同一个账号同一套绑定里 | 比 Worker 贵，而且要把子进程编排那一套（`packages/standby`）改成"起容器"而不是"起子进程" |
| **一台小机器** | 就是 `docs/61` 那台，只跑值守；账号与钱还在 Workers 这边，它拿一把内部令牌来用 `/v1/ai/*` | 又有一台要打补丁的机器，但改动最小——值守那一套代码一个字不用动 |

> **WP124 更新（09-21）**：转发了的在线聊天不需要值守在线——Workers 里的
> `ChatRelayDO`（每个工作区一个）只做转发（`/relay/<ws>/*`），收费档的对端是
> 按 `packages/standby` 托管的同一份 `apps/server`（一台小机器），
> 订阅生效后转发器把对端从商家本机换成托管实例。推荐与费用见 `docs/74` §5；
> WP114 留下的「在线值守在 Cloudflare 形态未开」就此收口。
>
> **WP128 更新（09-23）**：托管实例改落 **Cloudflare Containers**（Luoye：只管 Cloudflare / Vercel），
> 上表第一行那条路走了——不是改 `packages/standby` 去起容器，而是 `HostedInstanceDO` 直接用 `ctx.container`
> 起同一份 `apps/server`。全文见 **§13**。`/v1/cloud/health` 的 `standby` 仍是 `false`（那是 Compose 形态的值守），
> 新增 `hosted_instance` / `hosted_snapshots` 两格如实说绑没绑。

### 10.2 公共红人库（`packages/kol-public`）——**已做**（WP116）

原来的难处很具体：它的服务同时要**一张全局共享的红人表**和**某个组织的钱包**，而且要在**同一个同步上下文**里（查一次要扣一次积分）。Workers 形态下这两样在两个不同的 Durable Object 里——把它们凑到一起，只能让钱包那一侧变成异步，那正是 §1 要躲的东西。

WP116 按这里原来写的那条路做了：**两段式**。

```
入口 Worker                WalletDO(org)              KolPublicDO（单例）
   │  ① reserve  ─────────────▶  同步预扣
   │  ◀──────────────────────── 一笔 WalletReservation
   │  ② 带着那一笔打库  ──────────────────────────────▶  取数（钱包是"录音机"）
   │  ◀──────────────────────────────────────────────  响应 + 记下来的那几笔
   │  ③ apply    ─────────────▶  同步结算 / 释放 / 返额度
```

几条要点：

- **服务本身一个字没改**。`KolPublicService` 在 Workers 形态下拿到的 `wallet` 是一个**只录不做**的替身（`packages/kol-public/src/wallet-port.ts` 的 `deferredWallet`）：`reserve()` 把入口做好的那笔递回去，`settle` / `release` / `topup` 只记在一张纸上。所以"钱的读写全同步"一个字没破——同步性发生在 `WalletDO` 里，异步只在两个对象之间的那两跳，而那两跳中间没有任何"读一次钱再写一次钱"。
- **哪几条要预扣**由 `packages/kol-public/src/charge-map.ts` 说了算（`reveal` / `deep-audit` / `refresh` 三条 POST）。浏览、免费体检、基准、上报、回填、争议、插件配对**一笔都不预扣**——免费的东西不该因为余额用不了。这张表与 `service.ts` 里实际扣的那几笔由 `charge-map.test.ts` 对账。
- **③ 不走 `waitUntil`**。它是钱：用户拿到 200 的那一刻账必须已经记上。抄给看板那一份（`LedgerDO`）才是"顺便"。
- **兜底释放**：入口给了的预扣，凡是既没被结算也没被释放的，`apply` 那一步一律释放（`kol-wallet.ts` 的 `applyKolOps`）。库那头抛了（404、上游挂了、代码 bug）就走这条——不然那笔钱要等一小时的孤儿预扣清扫才回来，而用户会以为自己被扣了。
- **`KolPublicDO` 是全局单例**（`idFromName('kol-public')`）：这张红人表是**跨租户共享的一层事实**，按组织切开就等于每个组织自己攒一份，公共库的全部价值就没了。它**没有 alarm**——不管钱，也没有孤儿预扣要扫。
- health 里 `kol_public` 现在**如实**跟着 `KOL_PUBLIC` 这个 binding 走：绑了就 true，没绑就 false 且 `/v1/data/kol/*` 回 404。

#### 要敲哪几个 secret

| 名字 | 不配会怎样 | 去哪儿拿 |
|---|---|---|
| `AGENTSWS_KOL_EMAIL_KEY` | **不存邮箱**（`encrypt` 回 `undefined`，落库那一层一个字节都不写），搬家时 `kind: 'contact'` 全部 `skipped`。**绝不降级成明文** | 本机生成一把 32 字节：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `AGENTSWS_YOUTUBE_API_KEY` | 没有官方口（`refresh` 只能走 Apify 或者"只查库"） | Google Cloud Console → YouTube Data API v3 |
| `APIFY_TOKEN` | 没有降级口 | Apify 控制台 |
| `AGENTSWS_CLOUD_ADMIN_TOKEN` | 搬家那条路由进不去（它认后台会话**或**这把带外钥匙） | WP110 起就有的那一把，已经敲过了 |

```bash
cd apps/cloud-worker
pnpm exec wrangler secret put AGENTSWS_KOL_EMAIL_KEY
pnpm exec wrangler secret put AGENTSWS_YOUTUBE_API_KEY   # 可选
pnpm exec wrangler secret put APIFY_TOKEN                # 可选
pnpm exec wrangler deploy      # binding 与 v3 迁移都在 wrangler.toml 里
```

**这把邮箱密钥丢了就解不开已经落库的密文**（AES-256-GCM，没有后门）。存进密码管理器，别只存在 Cloudflare 后台里。

#### 搬家（把 KOLAgents 的存量搬过来）

两步，两个脚本，**连接串与钥匙都只从环境变量读**，脚本本身不打印任何一个。

```bash
# ① 导出：只读连接，出六个 NDJSON 到 ./.data/kolagents-public/
#    那个目录在 .gitignore 里，而且**里面有真实邮箱**——别提交、别外发。
node --env-file=<KOLAgents 的 env 文件> scripts/export-kolagents-public.mjs

# ② 推上去：按文件名排序（01-person → 02-creator → 其余）、一趟 500 行
AGENTSWS_CLOUD_ADMIN_TOKEN=… node scripts/import-kol-public.mjs https://cloud.agentsws.com
```

- **可重跑**：幂等键是 `渠道 + handle`（内容是 `渠道 + 原生 id`，指标快照再加 `observed_at`）。网断了就再跑一次第二步，第二趟全是 `updated`，一行都不重复。
- **坏行只算自己坏**：七百行里坏三行，另外六百九十七行照进，返回体里说清"这一行读不懂 × 3"。
- **`bio` 一个字都不导**：它是简介正文，而且简介里经常写着邮箱——落进 `extra` 就等于把明文邮箱存进了库。
- **移除过的人搬不回来**：后台按「从库中移除」时先写一条 opt-out 再删行，搬家每一种 kind 进门先问这张表。

#### 运营后台那一页

`/admin/kol`（`apps/cloud-admin/src/pages/kol.tsx`）：库里有多少、按平台、近 7 / 30 天新增、近 30 天的 reveal 与上游调用（次数 / 积分 / 我方成本，来自计量事件）、搜索、单条「从库中移除」。没绑 `KOL_PUBLIC` / 没接 `LEDGER` 时那一页分别回 503 与"看不了账"——**不画一堆 0**。

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
| `apps/cloud-worker/src/kol-public-do.ts` | 公共红人库 DO（**全局一个**，WP116） |
| `apps/cloud-worker/src/kol-wallet.ts` | 两段式的 ① 预扣与 ③ 照单执行（住在 `WalletDO` 里） |
| `apps/cloud-worker/src/kol-admin.ts` | 后台 → `KolPublicDO` 的四条内部路由与远端口 |
| `packages/kol-public/src/wallet-port.ts` | 那台"只录不做"的钱包（两段式的中间那一跳） |
| `packages/kol-public/src/charge-map.ts` | 哪几条路要先预扣（入口按它判） |
| `scripts/export-kolagents-public.mjs` / `scripts/import-kol-public.mjs` | 搬家两步（见 §10.2） |
| `apps/cloud-worker/src/do-sql.ts` | DO 的 SQL → 同步 SQL 口（`SyncDb`） |
| `apps/cloud-worker/src/hosted-instance-do.ts` | 客服增值服务的托管实例 DO（每订阅工作区一个容器，WP128，§13） |
| `apps/cloud-worker/src/hosted-routes.ts` / `hosted-admin.ts` | 托管实例的入口路由（两把钥匙）与后台那一块 |
| `packages/hosted/` | 托管实例的纯逻辑：起停判定、容器环境变量契约、托管令牌、按官方单价的费用估算 |
| `deploy/Dockerfile.hosted` | 容器镜像（只有 `apps/server`，amd64，不带工作区号与密钥） |
| `apps/cloud/src/app.ts` | **两个形态共用**的路由表与鉴权装配 |
| `deploy/smoke.sh` | 冒烟（两个形态共用） |
| `docs/61-…` | **Compose 自建形态**的 runbook（留给开源自建用户） |

## 13. 客服增值服务的托管实例：Cloudflare Containers（WP128，2026-09-23）

> Luoye 09-23 定：托管实例只在 Cloudflare 或 Vercel 上，他只想管这两个平台。常驻进程 +
> 长连接 + 本地库这三样 Workers / Vercel 都跑不了，所以落 **Cloudflare Containers**（同一个
> 账号、同一份账单）。订阅了客服增值服务的工作区**容器常驻不休眠**；未订阅的不起容器。
> 这一节取代 `docs/74` §5 原先「一台小机器」的推荐。

### 13.1 上游评估（按 docs/42 记；09-23 用 WebFetch 读的现行官方文档，查到什么写什么）

| 项 | 官方文档原话 / 数字 | 出处 |
|---|---|---|
| 状态 | Workers Paid 上可用（我们已经在付的那 $5） | `developers.cloudflare.com/containers/` |
| 怎么接 | 一个 DO 类出现在 `wrangler.toml` 的 `[[containers]]` 里（`class_name` + `image`），迁移用 `new_sqlite_classes`；运行时给这个 DO 一个 `ctx.container` | wrangler 配置文档 `#containers` |
| `[[containers]]` 的键 | `class_name`、`image`（Dockerfile 路径则 `wrangler deploy` 就地 build + push）必填；`instance_type` 缺省 `lite`；`max_instances` 缺省 20；`image_build_context`、`image_vars`、`rollout_step_percentage`、`rollout_active_grace_period` | 同上 |
| `ctx.container` | `running`、`start({ env, entrypoint, enableInternet })`、`exec`、`destroy`、`signal`、`monitor()`、`getTcpPort(port).fetch()`、`interceptOutboundHttp(s)` | `durable-objects/api/container/` |
| `Container` 类（`@cloudflare/containers`） | `defaultPort` / `sleepAfter` / `envVars` / `entrypoint` / `enableInternet` / `pingEndpoint`；钩子 `onStart` / `onStop` / `onError` / `onActivityExpired`；它**自己的 alarm 就是保活回路**（源码 `minTime = 3 * 60 * 1000`），官方建议别覆盖 `alarm()` 而用 `schedule()` | `github.com/cloudflare/containers` README 与 `src/lib/container.ts` |
| `sleepAfter` | 缺省 10 分钟；「多久没请求就停」。**没有上限值、没有「永不休眠」的开关**。`onActivityExpired` 不调 `stop()` 容器就不停，计时器续上 | 同上 |
| 冷启动 | 「often be in the 1-3 second range」，看镜像大小与启动代码 | `containers/platform-details/architecture/` |
| 盘 | 「All disk is ephemeral」——睡着再起来是一张新盘；快照「coming soon」 | 同上 |
| 关机 | 平台关容器先 `SIGTERM`，最多等 15 分钟再 `SIGKILL`；**发新镜像（rollout）也走这一套**——在跑的也会被换 | 同上 |
| 位置 | DO 与它的容器不保证同地；重起后可能换地方 | 同上 |
| 规格 | lite 1/16 vCPU · 256 MiB · 2 GB；basic 1/4 · 1 GiB · 4 GB；standard-1 1/2 · 4 GiB · 8 GB；standard-2 1 · 6 GiB · 12 GB；standard-3 2 · 8 GiB · 16 GB；standard-4 4 · 12 GiB · 20 GB | `containers/platform-details/limits/` |
| 镜像 | 单个镜像上限 = 所选规格的盘（最大 20 GB）；整账号镜像存储 50 GB | 同上 |
| 账号并发上限 | 内存 6 TiB、vCPU 1,500、盘 30 TB | 同上 |
| 计费 | 内存 $0.0000025 / GiB·秒、CPU $0.000020 / vCPU·秒、盘 $0.00000007 / GB·秒；每月含 25 GiB·小时内存、375 vCPU·分钟、200 GB·小时盘（**整账号共享**）；**内存与盘按开着的规格计，CPU 只按真用了的计**；「Charges stop after the container instance goes to sleep」；北美 / 欧洲出站 $0.025 / GB（含 1 TB） | `containers/pricing/` |

**取舍**：**不装 `@cloudflare/containers`**，直接用运行时的 `ctx.container`。理由三条：
① 它的 `Container` 继承 `cloudflare:workers` 的 `DurableObject`，普通 tsc 与 vitest 里 import 不进来，
而本包的每个 DO 都是朴素类、测试不起 workerd（`apps/cloud-worker/src/index.ts` 头注释）；
② 它的保活回路占着那一个 `alarm()`，我们自己还要在同一个闹钟上做「快照满 30 天删掉」与「停容器后一分钟强停」；
③ 少一个 npm 依赖、少一轮 docs/42 的升级。代价：官方以后在 `Container` 类里加的便利（比如更好的端口就绪探测）要我们自己照抄。
`upstreams.yml` 登记了 `cloudflare-containers`（`kind: reference`），wishlist 盯「平台级常驻开关」与「盘快照」——任何一个出了就回头重判。

**偏离派工单的一处**：派工单写「继承 Cloudflare 的 `Container` 类」——实际是**同一个底座**
（`ctx.container`）+ 我们自己的保活 alarm，理由同上。

### 13.2 怎么跑（一个订阅的工作区一个容器）

```
访客 ──▶ ChatRelayDO(ws)  ──(两格对端：hosted 在就给 hosted，否则给本机)──▶ 容器里的 apps/server
             │  订阅开通 / 取消 / 六小时一拍                      ▲  外连 wss://…/relay/<ws>/connect（peer=hosted）
             ▼                                                   │
        HostedInstanceDO(ws) ──ctx.container.start({ env })─────┘
             │  alarm 每 3 分钟：打 /v1/health（心跳）、没在跑就按退避重起、三次不应强停重起
             ▼
        R2 `agentsws-hosted-snapshots`：容器每 6 小时 + SIGTERM 时推一份工作区包；起来先拉最新那份
```

- **起停跟着订阅走**（`@agentsws/hosted` 的 `desiredFor`）：`active` / `cancelling` / `grace` → 跑；
  `suspended`（宽限 30 天到期）/ `none`（取消且当期用完）→ 停：先 `SIGTERM`（容器推最后一份快照），
  一分钟后还在就 `destroy`；快照留 30 天，30 天内重新订阅接着用，过期删。
- **常驻怎么做**：官方没有永不休眠的开关，所以 `HostedInstanceDO` 的 alarm 每 3 分钟醒一次
  （与 `Container` 类自己的保活节奏同一个数），打一次容器的 `/v1/health`——这一下既是心跳，也是一次真活动。
  **这一条要在第一次真部署后亲眼确认**（§13.5 第 6 步）：跑一小时，后台那一格一直是「运行」。
- **两把钥匙**：容器拿到的云令牌是 `wst_hosted_<工作区>.<随机>`（只有 `ai` + `wallet:read`，每次起容器换一把，
  停容器即作废，DO 里只存哈希）；连转发器用另一把托管配对 `hrp_…`（转发器只存哈希，**与商家本机那把分开验**，
  互相冒充不了）。托管令牌只在 `/v1/ai/*`、`/v1/wallet` 与 `/v1/hosted/snapshot` 上认，开不了订阅、签不了配对、拉不走留言。
- **AI 计积分**：容器里的 `apps/server` 默认模型被换成「agentsws 云（用积分）」，走 `/v1/ai/*`，在这个组织的
  `WalletDO` 里按 `ai` 块扣——与商家本机用云模型同一条路。
- **本机上线对齐**：商家本机开机后，转发器**两格并存**（以前后连的会把先连的挤掉），访客消息仍给托管；
  工作台「转发方式」第三项有两颗按钮：「用本机这一份更新云端」（导出本机包 → R2，托管实例下次重起就用它，
  秘密库不带上去）与「把云端那一份取回来」（落进本机备份目录，**不自己导入**——WP36 那条：跑着的进程不换自己脚下的库）。
- **镜像**：`deploy/Dockerfile.hosted`（照 `Dockerfile.cloud` 的多阶段做法，只建 `apps/server`，不带工作台；
  `linux/amd64`；镜像里**没有任何工作区号与密钥**）。大小见 WP128 报告。

### 13.3 费用（按官方单价，**每个订阅工作区一个容器**）

一个月按 30 天 = 2,592,000 秒；CPU 按「10% 的时间在忙」估（客服实例大部分时间在等访客，话轮里真正耗时的是等模型）。
账号每月包含的量是整账号共享的（25 GiB·小时内存只够一个 basic 跑一天多），摊到每个工作区 ≈ 0，不扣。

| 规格 | 内存 | 盘 | CPU（10% 忙） | **常驻一个月** | 30 积分（¥30 ≈ $4.2）盖得住吗 |
|---|---|---|---|---|---|
| lite（1/16 vCPU · 256 MiB · 2 GB） | $1.62 | $0.36 | $0.32 | **≈ $2.31** | 盖得住，毛利约 45% |
| **basic**（1/4 · 1 GiB · 4 GB，**本轮缺省**） | $6.48 | $0.73 | $1.30 | **≈ $8.50** | **盖不住**，每个工作区每月亏约 $4.3 |
| standard-1（1/2 · 4 GiB · 8 GB） | $25.92 | $1.45 | $2.59 | ≈ $29.96 | 远远盖不住 |

- 与派工单估的「$4–6 / 月」差在规格：那个数落在 lite 与 basic 之间。**选 lite 还是 basic 要 Luoye 定**
  （报告第 3 节）：`apps/server` 空闲时本机实测约 75 MB，但跑话轮、推快照（VACUUM INTO + 打 zip）时会涨，
  256 MiB 余量薄，OOM = 聊天窗掉线。建议：先 basic 上线，看一周 Cloudflare 后台的真实内存峰值，
  峰值稳定在 180 MB 以下就降 lite（改 `wrangler.toml` 两处 + deploy 一次）。
- 另外两笔：R2 快照（每工作区最多 3 份、几 MB，≈ $0）；AI 调用照常按积分扣（不在容器费里）。
- 运营后台组织抽屉的「客服增值服务」一格显示**本月已花**与**常驻整月**两个估算（`packages/hosted/src/cost.ts`，
  单价在 `pricing.ts`，官网改价改那一张表）。**是估算不是账单**，真账看 Cloudflare 后台。

### 13.4 以后改共享容器（一个容器托管 N 个工作区）

本轮每个订阅工作区一个容器：最快、隔离最干净（一个租户的进程崩了、被攻下来都碰不到别人）。
内测阶段客户少，这是对的。**什么时候该切**：

- **钱**：basic 每个工作区每月约 $8.5，30 积分盖不住；lite 约 $2.3 盖得住。一台 standard-2（1 vCPU · 6 GiB，
  常驻约 $46 / 月：内存 $38.9 + 盘 $2.2 + CPU 10% 忙 $5.2）按每个工作区 ~150 MB 能装 ~30 个，摊下来每个约 $1.5。
  对 basic（$8.5 / 个）**超过 ~6 个订阅工作区**共享版就更便宜；对 lite（$2.3 / 个）要**超过 ~20 个**才划算。
- **上限**：`max_instances = 50`（`wrangler.toml`）。到 40 个就该准备切（或先调大这个数）。

已经留好的口子（改的时候**不用动的**）：镜像里没有工作区号；启动参数里工作区号只出现在 `AGENTSWS_WORKSPACE_ID`
一处（转发器地址是容器里拼出来的）；DO → 容器的形状是 `HostedContainerSpec = { cloud_base_url, key, tenants[] }`
（`packages/hosted/src/env.ts`，本轮 `tenants.length` 只能是 1）；`apps/server` 本来就是多品牌的（一个进程多个工作区）。

要改的地方（四处）：
1. `HostedInstanceDO` 按「池」命名（`idFromName('pool-<k>')`）而不是按工作区；加一张「工作区 → 池」的表
   （放 `AccountsDO` 或一个新的单例 DO），`ChatRelayDO.#syncHosted` 与 `hostedTokenVerifier` 按这张表找池；
2. 租户下发从「拍平进环境变量」换成「容器起来后经控制口下发」（`getTcpPort(4317)` 打一个只在容器内网可达的
   `/v1/hosted/tenants`），`buildHostedEnv` 只留容器级的那几项；
3. 库密钥从「每容器一把」换成「每租户一把」（`apps/server` 的秘密库本来就按品牌加前缀分，要再加一层按租户的密钥）；
4. 快照按租户拆（现在一个容器推一份整目录的包）：`exportWorkspace` 按品牌目录导，R2 键名已经按工作区分了。

### 13.5 Luoye 上线时要亲手做的事

1. 本机装好并开着 **Docker**（`wrangler deploy` 要就地 build 镜像并推到 Cloudflare 自己的仓库，不用 Docker Hub）；
2. 建快照桶：`pnpm -F @agentsws/cloud-worker exec wrangler r2 bucket create agentsws-hosted-snapshots`；
3. 生成并填种子：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`，
   然后 `wrangler secret put AGENTSWS_HOSTED_KEY_SEED` 粘进去，**同时存进密码管理器**——丢了就读不回已有的快照；
4. `pnpm -F @agentsws/cloud-worker exec wrangler deploy`（第一次 build amd64 镜像，Apple 芯片上要十几二十分钟）；
5. 用自己的测试工作区在工作台「聊天窗 → 转发方式」第三项点「开通」（扣 30 积分）；
6. 看运营后台「组织 → 客服增值服务」：一两分钟内从「启动中」变「运行」，**放一个小时**，确认一直是「运行」、
   最近心跳一直在 3 分钟以内（这一条验证「心跳保活」在真平台上成立——官方文档没写它一定成立）；
7. 关掉本机，从网站聊天窗发一句，确认有回复、`/v1/ai/*` 扣了积分；再开本机，确认访客消息仍给托管；
8. 去 Cloudflare 后台 → Containers 看一周真实内存峰值，决定 basic 还是 lite（§13.3）。
