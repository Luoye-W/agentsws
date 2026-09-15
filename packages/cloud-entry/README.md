# @agentsws/cloud-entry

49 M3 的**服务入口**：我们自己的一层薄网关。一句话——

> 验令牌 → 查价目算预扣 → 余额够就放行 → 转发到后端 → 按实际用量结算 → 记一条计量事件（**只记计量，不记正文**）。

这个包**不起服务**，只导出路由（`entryRoutes(deps)` / `mountEntryRoutes(app, deps)`），
由云侧那个进程挂上去。本地联调用 `bin/dev.mjs`（内存令牌 + 内存钱包 + 假上游，不需要任何密钥）。

## 为什么计费不在 New API 里

New API 解决的是"一把内部密钥 → 几十家模型、格式互转、渠道轮换、故障切换"，这块自己写没有意义。
但它的额度 / 用户 / 令牌体系是**给它自己的用户**设计的——我们的账号、余额、社媒数据接口、
值守订阅都不在它里面，两本账必然对不上（49 §1）。所以它只做模型汇聚层，账在这一层。

## 路由

| 方法 | 路径 | 需要的 scope | 做什么 |
|---|---|---|---|
| POST | `/v1/ai/chat/completions` | `ai` | OpenAI 兼容对话口，流式与非流式都支持 |
| POST | `/v1/ai/embeddings` | `ai` | OpenAI 兼容向量口 |
| GET | `/v1/ai/models` | `ai` | 可用模型清单（不扣积分——它不产生上游成本） |
| GET | `/v1/wallet` | `wallet` | 余额：永不过期 / 有期限 / 即将过期 / 预扣中 |
| GET | `/v1/wallet/usage?group=capability\|workspace\|day&from&to` | `wallet` | 用量明细（**只聚合计量事件**） |
| GET | `/v1/wallet/pricing` | `wallet` | 价目表（能力 → 单位 → 积分） |
| POST | `/v1/wallet/topup` | `wallet` | 建一笔充值单（这一版只做 Stripe） |
| POST | `/v1/wallet/topup/stripe/webhook` | 无（验签名） | 付成功 → 入账，同一个 `session_id` 只入一次 |

`wallet.admin` 那个 scope 决定 `/v1/wallet/usage` 看到的是整个组织还是只有自己那个工作区——
同一条路由，按 scope 裁，不另开一条"成员版"。

## 环境变量

**这个包里不写任何密钥。** 所有值从环境变量来，由装配方（云侧进程）取好再注入。

| 变量 | 做什么 | 不给会怎样 |
|---|---|---|
| `AGENTSWS_NEWAPI_KEY` | 打上游模型汇聚层（New API）的内部密钥 | `/v1/ai/*` 回 500 + 一句人话 |
| `AGENTSWS_NEWAPI_BASE_URL` | 上游 OpenAI 兼容口根地址（`https://…/v1`） | 装配方自己决定默认值 |
| `STRIPE_SECRET_KEY` | 建 Checkout Session | `/v1/wallet/topup` 回 501 + 一句人话 |
| `STRIPE_WEBHOOK_SECRET` | 验 webhook 签名 | webhook 回 501 |
| `AGENTSWS_CLOUD_PUBLIC_URL` | 付完跳回哪儿 | Stripe 用它自己的默认页 |
| `PORT` | 只给 `bin/dev.mjs` 用（默认 4401） | — |

## 三条纪律

1. **令牌明文只出现一次**：从 `Authorization` 头读出来交给 `verifier`，函数返回后没人再引用它。
   请求上下文里是账号 / 组织 / 工作区 / scopes，**没有令牌**。不进日志、不进错误信封。
2. **计量事件只有八个字段**（49 M6）：能力、单位、数量、积分、时间、组织、工作区、请求号。
   `metering_events` 这张表里根本没有地方放正文——想存也存不进来。
3. **钱在组织级**（52 §2 O3）：lot 与计量事件都按 `org_id` 存，`workspace_id` 只做分组维度。
   一个账号一个余额；团队版由 owner 一个账号付，成员用工作区令牌。

## 数据驻留

请求带 `X-Agentsws-Region: cn` 时，只允许境内可用的模型，否则 **422 + 一句人话**
（"这个工作区选了数据不出境，而 xxx 只在境外可用"）。判据先看装配方给的 `region_map`，
没有这一条就退回价目表里的 `cn` 标记（`pricing.json` 的 `cn_vendors`）——两边都说不出来的一律不允许。

## 本地联调

```bash
pnpm exec tsc -b
node packages/cloud-entry/bin/dev.mjs

curl -s localhost:4401/v1/wallet -H 'Authorization: Bearer wst_dev'
curl -s localhost:4401/v1/wallet/pricing -H 'Authorization: Bearer wst_dev'
curl -s localhost:4401/v1/ai/chat/completions -H 'Authorization: Bearer wst_dev' \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}]}'
# 没有 ai scope 的那把：403
curl -s -o /dev/null -w '%{http_code}\n' localhost:4401/v1/ai/models \
  -H 'Authorization: Bearer wst_dev_nowallet'
```

## 合并说明（给审核者）

- `TokenVerifier`（`src/types.ts`）是 WP58 `packages/contracts/src/cloud.ts` 里
  `CloudTokenVerifier` 的**局部声明**，结构完全相同。合并时改成
  `import type { CloudTokenVerifier } from '@agentsws/contracts'` 即可，一行的事。
- 这个包故意不建 `apps/cloud`——云侧骨架是 WP58 的活。合并时把 `mountEntryRoutes`
  挂进那边的 Hono 应用就行。
