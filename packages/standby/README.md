# @agentsws/standby

49 §6 WP60 / 48 L6：**在线值守**的云侧编排。

一句话：**同一时刻只有一个服务进程**。值守开 = 你的工作区服务进程在云上跑，
本地桌面变成"远程窗口"。不做双活，不做同步——同步要解决的那个问题（两份真源打架）
在这里根本不存在，因为只有一份。

## 这个包是什么

一个**库 + 路由包，不起服务**（风格同 `packages/cloud-entry`）：由 `apps/cloud`
的 `src/standby.ts` 挂上去。

| 文件 | 管什么 |
|---|---|
| `orchestrator.ts` | 进程池：起 / 健康 / 崩溃退避 / 停。**没有 `setInterval`、没有 `Date.now()`**——`tick()` 由装配方按节奏调 |
| `service.ts` | 订阅（接 `Wallet`）+ 搬家（导入 / 导出）+ 状态机 |
| `child-token.ts` | 子进程那把云令牌：自己签、自己验，动作集只有 `ai` + `wallet:read` |
| `keyring.ts` | 每个租户一把库密钥，落在**租户自己的目录**里，不进编排层的库 |
| `proxy.ts` | 公网入口 `/w/:workspace_id/*` → 子进程，流原样穿过去（SSE 是真的流式） |
| `routes.ts` | 控制面五条（列表 / 开通 / 状态 / 停 / 导入 / 导出）+ 公网入口 |
| `store.ts` | 编排层的库（内存 + sqlite）。**没有一个字节的租户数据** |
| `node-host.ts` | `node:` 的真家伙（spawn / fs / 端口 / 随机与哈希）只在这一个文件里 |

## 路由

| 路径 | 鉴权 | 做什么 |
|---|---|---|
| `GET /v1/standby/workspaces` | 工作区令牌 + `standby` | 本组织的值守清单 + 座位单价 |
| `POST /v1/standby/workspaces` | 同上 | 开通 / 续期（按 `standby.seat.month` × 座位数向钱包收一个月） |
| `GET /v1/standby/workspaces/:id` | 同上 | 状态 |
| `POST /v1/standby/workspaces/:id/stop` | 同上 | 停（**不删数据**） |
| `POST /v1/standby/workspaces/:id/import` | 同上 | 上传 WP36 导出包 → 校验 → 解包 → 起进程 |
| `GET /v1/standby/workspaces/:id/export` | 同上 | 反向搬家：把云上这一份导出来（到期停了也能导） |
| `ALL /w/:workspace_id/*` | **公开** | 原样代理到子进程。末端用户走子进程自己的 magic link 会话 |

## 三条不可违反的纪律

1. **编排层不认识租户的数据。** 租户密钥只经环境变量传一次，落在租户自己的目录里；
   编排层的库里没有它，日志里没有它，导出包里也没有它。
2. **代理不读、不记正文。** 请求体与响应体都是流，原样穿过去——
   这同时保证了 SSE 是真的流式，与 49 M6「入口不存正文」在这条路上也成立。
3. **先校验再解包。** 反过来的话，一个坏包会先把半个目录铺进去，
   然后我们才发现它坏——那时候这个租户的数据已经是"一半新一半旧"了。

## 子进程拿到的环境变量

| 变量 | 值 |
|---|---|
| `AGENTSWS_DATA_DIR` | `<云数据目录>/standby/<workspace_id>/` |
| `AGENTSWS_PORT` | 分到的**本机回环**端口 |
| `AGENTSWS_BIND_HOST` | `127.0.0.1`（公网只能走云进程那层代理） |
| `AGENTSWS_DATA_KEY` / `AGENTSWS_SECRETS_KEY` | 这个租户那一把（21 按租户加密） |
| `AGENTSWS_CLOUD_BASE_URL` | 云自己的地址（子进程的模型 provider 指回来） |
| `AGENTSWS_CLOUD_WORKSPACE_TOKEN` | 子进程那把 `ai` + `wallet:read` 令牌 |
| `AGENTSWS_PUBLIC_BASE_URL` | `https://<云>/w/<ws>`（回调与 widget 地址用它） |
| `AGENTSWS_WORKSPACE_ID` | 工作区 id |

基础环境**不是** `...process.env` 的整份继承，是一张白名单
（`PATH` / `HOME` / `TMPDIR` / `TZ` / `LANG` / `LC_ALL`）：云进程自己的环境里有
New API 与 Stripe 的密钥，整份继承过去等于每个租户的进程里都有一份我们的钥匙。
