# @agentsws/kol-public

云上的**公共红人库服务**（48 §5.3 / 49 §6 WP61）。把 KOLAgents 的 `public_*` 那一层
原样重建成 agentsws 云上的一个服务：插件采集汇聚、共享库读写、k-匿名基准、
YouTube 配额池与 Apify 降级。

**这个包不起服务**——它导出 `mountKolPublicRoutes(app, deps)`，由 `apps/cloud`
挂上去（写法同 WP59 的 `@agentsws/cloud-entry`、WP60 的 `@agentsws/standby`）。

与 WP67 的 `@agentsws/kol-core`（本地那一半）**零 import**：这边是跨租户的共享事实层，
那边是一个工作区自己的归属数据，两层之间只有一个自足键 `{ channel, handle }`。

## 路由（前缀 `/v1/data/kol`）

鉴权 = 工作区服务令牌（`wst_…`）+ `data` 动作集，**只有插件上报那一条例外**。

| 方法 | 路径 | 鉴权 | 计价 |
|---|---|---|---|
| GET | `/creators?channel=&q=&min_followers=&category=&limit=` | `data` | 免费（记 0 积分计量） |
| GET | `/creators/:channel/:handle/audit` | `data` | 免费（记 0 积分计量） |
| POST | `/creators/:channel/:handle/reveal` | `data` | `data.kol.lookup` |
| POST | `/creators/:channel/:handle/deep-audit` | `data` | `data.kol.audit` |
| POST | `/creators/:channel/:handle/refresh` | `data` | `social.fetch`（**没真取到就不收**） |
| GET | `/benchmarks?channel=&category=&followers_band=` | `data` | 免费（记 0 积分计量） |
| POST | `/creators/:channel/:handle/observations` | `data` | 免费（贡献有奖励） |
| POST | `/creators/:channel/:handle/contact` | `data` | 免费（贡献有奖励） |
| POST | `/creators/:channel/:handle/disputes` | `data` | 免费 |
| POST | `/plugins/pair` | `data` | 免费 |
| POST | `/plugins/:sha/revoke` | `data` | 免费 |
| POST | `/plugins/observations` | **插件令牌 `plg_…`** | 免费（贡献有奖励） |

免费动作也记一条 **0 积分**的计量事件——用量看板要知道这些能力被用了多少次，
"免费"不等于"没发生过"。计量事件只有八个字段（49 M6）：**红人名字没有地方放**。

## 风控参数（都在契约里，改它要改契约）

| 参数 | 值 | 在哪 |
|---|---|---|
| 每个贡献者每天最多上报 | 500 条（超了 429） | `MAX_PLUGIN_OBSERVATIONS_PER_DAY` |
| 多少条有效观察换 1 积分 | 100 | `OBSERVATIONS_PER_CREDIT` |
| 同一 handle 多久内重复不计奖励 | 24 小时 | `OBSERVATION_DEDUPE_HOURS` |
| 单个贡献者每天奖励封顶 | 5 积分（超出的明天接着拿） | `MAX_DAILY_REWARD_CREDITS` |
| 奖励积分有效期 | 90 天（`granted` 类，到期清零） | `CONTRIBUTION_CREDIT_TTL_DAYS` |
| 回填一条新联系方式 | 1 积分 | `CONTACT_REWARD_CREDITS` |
| k-匿名的 k | 20 条观察 / 桶 | `BENCHMARK_MIN_SAMPLES` |
| 出体检报告的最少样本 | 3 条 | `MIN_AUDIT_SAMPLES` |
| 插件令牌有效期 | 30 天 | `PLUGIN_TOKEN_TTL_MS` |
| YouTube 全站日配额 | 10000 单位 | `YOUTUBE_UNITS_PER_DAY` |

## 库（`<AGENTSWS_CLOUD_DATA_DIR>/kol-public.sqlite`）

`kol_creators` / `kol_observations` / `kol_contacts` / `kol_disputes` /
`kol_plugin_tokens` / `kol_plugin_quota` / `kol_benchmarks_cache`。

两张表的形状是纪律而不是设计：

- **`kol_contacts` 没有明文邮箱这一列**——只有 `email_sha256`（去重与"同一人合并"）
  与 `email_cipher`（AES-256-GCM，云侧租户无关的服务密钥）。想存明文也没地方存。
- **`kol_plugin_tokens` 没有明文令牌这一列**——只有 `sha256`；撤销是 `revoked_at`
  一列，不是删行。

`kol_observations` 的列就是字段白名单那几个（`PUBLIC_OBSERVATION_FIELDS`）：
**正文、评论、私信、视频文案一个字都收不进来**，白名单多一个键整批拒。

`kol_plugin_quota` 除了按天的那些行，还有两种特殊行：`day = 'lifetime'` 是累计计数
（奖励按它算），`subject = 'source:youtube'` 是 YouTube 的日配额池。

## 环境变量（值一个都不在仓库里）

| 名字 | 做什么 | 没有它会怎样 |
|---|---|---|
| `AGENTSWS_KOL_EMAIL_KEY` | 邮箱密文的服务密钥（32 字节，hex 或 base64url） | 联系方式**收不了也 reveal 不了**（一句人话），**绝不降级成明文** |
| `AGENTSWS_YOUTUBE_API_KEY` | YouTube 官方 Data API | 直接走降级 |
| `AGENTSWS_YOUTUBE_UNITS_PER_DAY` | 全站日配额单位数 | 按 10000 |
| `APIFY_TOKEN` | Apify 降级 | **不降级**，回一句"今天配额用完了"，不悄悄换别的源 |
| `AGENTSWS_CLOUD_DATA_DIR` | 云侧数据目录（库放这儿） | 内存档（测试） |

生成一把邮箱密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
（或包里的 `newEmailKey()`）。**换密钥会让已有密文解不开**——换之前要先把库里的密文重加密。

## 这一版没做的

- **外部源的真调用**：`youtubeSource` / `apifySource` 只有接口与配额、降级判定，
  真的 HTTP 调用留给后续 WP。在没有真 key 可验的地方照着文档写解析，
  第一天就会用错字段名，而错的地方是**所有人共用的那张公共库**。
- **深度体检的深度**：`deep-audit` 这一版是骨架（免费报告 + 基准分位，标 `depth: 'deep'`），
  报告的 `note` 里会写清楚现在买到的是什么。
- **争议的裁决**：只记不裁，owner 后台看。
