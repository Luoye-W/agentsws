# 匿名使用数据：事件清单

工坊会发一小份**匿名**使用数据，用来知道哪些页面、岗位、按钮有人用，任务成没成，哪里在报错。
这份文档写清楚发什么、不发什么、怎么关，给贡献者和想核对的用户看。

权威定义在代码里：`packages/contracts/src/telemetry.ts`（事件清单与属性白名单）。
改了那张表，这份文档要一起改；`packages/contracts/test/telemetry.test.ts` 会核对两边对得上。

## 怎么关、什么时候根本不发

- **设置 → 数据与隐私 →「帮助改进工坊」**，关掉立刻停。关掉时还没发出去的也一起丢掉。
- 第一次真的要发时，右下角会提示一句，可以直接点「不发送」。
- 下面几种情况**一条都不发**，SDK 也不加载：
  - 没有上报地址：只有官方桌面安装包会给（环境变量 `AGENTSWS_TELEMETRY_HOST`）。从源码跑、跑测试、自己部署，默认都没有。想关掉安装包里的，把它设成 `off`；
  - 上报地址那边没配项目 key；
  - 设置里关着。

## 数据怎么走

```
工作台（posthog-js，只跟本机说话）
  → 本机服务 /v1/telemetry/*   ← 在这里再过一遍白名单、核对 key
  → 官方转发地址（自家域名）
  → PostHog
```

- 浏览器只往本机服务发（同源），不直接连外网；桌面版的内容安全策略不需要放宽。
- 本机服务把每条事件**再过一遍白名单**再转出去，不信前端那一遍。
- 浏览器里不存任何东西（SDK 用内存模式）。

## 不发什么

信件、草稿、回复内容、客户名、商品名、店铺名、你输入的任何文字、地址栏里的具体编号和参数、
报错的文字内容、邮箱。

这不靠每个调用的地方自己记得清理，而是**从结构上**拦住：

- 只认清单里的事件名，清单外的一律丢（包括 SDK 自己想发的 `$exception`、`$web_vitals`、`$pageleave`、`$rageclick` 等）；
- 自动点击记录（`$autocapture`）在 SDK 里就**遮住全部文字和全部属性**，出门前再只留四样：哪种操作、元素的 testid、标签名、
  路由模板（见下面「自动点击记录」）；
- 只认清单里的属性，值还要过规则：只能是枚举值、小写 ASCII 编号、路由模板、版本号、随机生成的匿名编号。
  中文、空格、大写、`@`、网址、长串数字（电话、订单号）一律过不去；
- 页面地址只报**路由模板**：`/positions/a_9f3/duties/dtc.support?draft=…` 发出去是 `/positions/:assignment/duties/:role_id`；
- 按钮只报**固定编号**，不读按钮上的字（按钮上的字可能就是一个客户名）；
- 用户自己建的职责和岗位一律记成 `custom`（名字里可能有品牌或商品）；
- SDK 想记的「首次来源网址」「引荐页」（`$set` / `$set_once`）整段丢掉。

## 用户标识

- `install_id`：这台电脑上工坊的**匿名设备号**，随机生成，存在本机数据目录的 `telemetry.json` 里，与账号、邮箱无关。
  浏览器那一侧也直接用它作匿名号，所以同一台电脑的页面访问和任务记录能对上。
- `account_id`：登录了工坊云账号时附上**账号编号**（不是邮箱）。
- 不调用 `identify`，不建「人物资料」。

## 事件清单

每条事件都带下面「公共属性」里有的那几样。

### 公共属性

| 属性 | 是什么 | 例子 |
|---|---|---|
| `app_version` | 工坊版本 | `0.2.1-beta.5` |
| `shell` | 在哪儿跑：桌面版 / 浏览器 / 本机服务 | `desktop` · `web` · `server` |
| `lang` | 界面语言 | `zh` · `en` |
| `market_region` | 市场地区：界面是中文就带 `CN`，以它为准；不是中文就不带，地区交给 PostHog 按 IP 算（IP 本身不存） | `CN` |
| `mode` | 使用模式 | `solo` · `peers` · `company` |
| `install_id` | 匿名设备号 | `ins_3f9a…` |
| `account_id` | 工坊云账号编号（登录了才有） | `org_…` |

本机服务自己发的事件（任务收尾、卡片决定）不知道界面语言，用的是工作台最近一次转过来的 `lang`，`market_region` 同样按它算。

另外留着 SDK 自带的几样：操作系统、浏览器大类、设备类型、屏幕 / 窗口尺寸、会话编号、SDK 版本。

### 工作台发的

| 事件 | 什么时候 | 属性 |
|---|---|---|
| `$pageview` | 打开了一页（换一个岗位 / 事项也算一次；报的仍是路由模板） | `route`、`position_template`、`role_id` |
| `app_opened` | 打开一次工作台 | — |
| `ui_click` | 点了下面「关键按钮」里的一颗 | `button_id`、`route`、`position_template`、`role_id` |
| `client_error` | 页面报错（错误边界接住的、`window.onerror`、没人接的 Promise 拒绝） | `error_kind`、`error_name`（错误类名，如 `TypeError`）、`scope`、`route` |
| `$autocapture` | 点了 / 改了 / 提交了一个带 testid 的元素（见下面「自动点击记录」） | `$event_type`、`testid`、`tag`、`route`、`position_template`、`role_id` |

### 按岗位 / 职责看（`position_template`、`role_id`）

岗位页、职责页、事项页、卡片页上的页面访问、按钮、自动点击记录，另带这一页是哪个岗位、哪条职责：

- `position_template`：**内置岗位模板**的编号（如 `customer-care`、`kol-marketing`、`owner`）。内置岗位改了名编号也不变，
  所以就算岗位叫「某某品牌旗舰店客服」，出门的也只有 `customer-care`；用户自己建的岗位一律 `custom`；
- `role_id`：**内置职责**的编号（如 `dtc.support`、`kol.youtube`）；用户自己建的一律 `custom`。
  事项页带事项挂的那条职责；点在一张卡上（收件箱一行、第三栏的卡）带那张卡的职责；
- 岗位名、职责名永远不带。工作台先把不像编号的换成 `custom`，本机服务转发前再按随软件带的内置目录核一遍。

`task_finished` 里的 `position_id` 与这里的 `position_template` 是同一套编号（WP476 起就叫 `position_id`，没改名）。

### 自动点击记录（`$autocapture`）

用来看「大家都点哪儿」，不用每颗按钮手工登记。它比关键按钮更容易带出东西，所以收得更紧：

- SDK 里开着 `mask_all_text` 和 `mask_all_element_attributes`：元素上的字、`href`、`class`、`title`、所有属性都**不采**；
- 出门只留四样：
  - `$event_type`：`click` / `change` / `submit`（只开这三种）；
  - `testid`：元素（或离它最近的上层）的 `data-testid`，**只认工作台源码里写死的**——
    `packages/contracts/src/telemetry-testids.ts` 是从源码扫出来的表（`node scripts/gen-telemetry-testids.mjs` 生成）。
    带变量的 testid（`brand-row-${id}`、`rail-office-sheet-tab-${工作表名}`）只发模板 `brand-row-:x`，变量那段永远不出门；
    不在表里的整条不发；
  - `tag`：标签名（`button`、`a`、`div`…，只认一张固定表）；
  - `route`：路由模板；
- `$el_text`、`$elements`、`$elements_chain`、`$external_click_url`、`$element_selectors`、`attr__*` 一律丢；
- 本机服务转发前按同一张表再查一遍。
- 热力图、死点击、连点、性能、录屏在代码里照旧关着。

### 本机服务发的

| 事件 | 什么时候 | 属性 |
|---|---|---|
| `task_finished` | 一次 AI 运行收尾 | `outcome`（`success` / `failure` / `cancelled`）、`cost_tier`、`cache_tier`、`role_id`、`position_id`、`error_code`、`runtime` |
| `card_decided` | 一张卡被人定了 | `decision`（`approve` / `edit` / `reject` / `other`）、`card_kind`（卡的类型编号，如 `outbound_draft`）、`role_id`（卡挂在哪条内置职责上，自建的是 `custom`） |

- `cost_tier`：这次运行花费的大概档位（`none` / `low` / `mid` / `high` / `top`），不发具体数字；
- `cache_tier`：模型缓存命中的大概档位（`none` / `low` / `mid` / `high`）；
- `role_id` / `position_id`：内置职责 / 岗位的编号；用户自己建的是 `custom`；
- `error_code`：失败码（如 `model_timeout`），不带报错文字。

### 关键按钮（`button_id`）

工作台里哪颗按钮对应哪个编号，见 `apps/workstation/src/lib/telemetry/buttons.ts`。

| 编号 | 按钮 |
|---|---|
| `assistant.send` | 我的助理里发一句 |
| `matter.send` | 事项里发一句 |
| `messages.send` | 收件箱里发出回复 |
| `report.send` | 报表里发出 |
| `card.approve` | 卡片「通过」 |
| `card.reject` | 卡片「驳回」 |
| `matter.handoff` | 事项「交给对方」 |
| `palette.handoff` | ⌘K 里「交给对方」 |
| `onboarding.finish` | 首次设置向导「完成」 |
| `cloud_login.send_code` | 登录工坊账号：发验证码 |
| `cloud_login.verify` | 登录工坊账号：验证 |
| `account.topup` | 充值 |
| `nav.settings` | 打开设置 |
| `shell.search` | 顶栏搜索 |
| `role.reconfirm` | 职责升级后点「确认」 |
| `position.settings` | 岗位页「设置」 |
| `connection.go` | 连接页「去连接」 |
| `shopify.connect` | 连接 Shopify |
| `setup.connect_start` | 配置卡「开始连接」 |
| `update.check` | 检查更新 |
| `update.restart` | 更新后「立即重启」 |

## 另报 GA4 的四件关键事

官网和软件共用一个 Google Analytics 4 媒体资源，用来看「官网访客 → 下载 → 第一次打开 → 用起来」这条线。
软件只往 GA4 报下面四件事，和上面同一个开关（关了一件都不发）：

| 事件 | 什么时候 | 次数 |
|---|---|---|
| `app_first_open` | 第一次打开工作台（GA4 自己的 `first_open` 是保留名，所以加了前缀） | 一台电脑一次 |
| `setup_complete` | 首次设置向导走完、建好了岗位 | 一台电脑一次 |
| `first_task` | 第一次有一次 AI 任务跑成 | 一台电脑一次 |
| `daily_active` | 每天第一次打开工作台（按这台电脑的本地日期） | 一天一次 |

- 每件只带：`app_version`、`market_region`（界面中文才带 `CN`）、GA4 要的 `session_id` 与 `engagement_time_msec`；
  GA4 的 `client_id` 就是上面的匿名设备号 `install_id`。不带任何业务内容、不带账号编号。
- 路线：本机服务 → 官方转发地址的 `/mp/collect` → GA4 Measurement Protocol。转发那边没配 GA4 的密钥时，
  `/config` 说 `ga4: false`，本机服务一件都不发；转发那边自己也只认这四个名字、这几个参数。
- 国家：界面中文的记成中国（`CN`）；别的由转发那边按 Cloudflare 判断的国家填，**不把 IP 交给 Google**。
- 发成功才记在 `telemetry.json`（`ga4` 那一格）；发不出去下次打开再发。

## 录屏回放

默认**关**，代码里留了开关。要开得在上报地址那边单独打开；开了也强制：
遮住全部文字和输入框、挡掉图片 / 视频 / 画布 / 内嵌页、不录网络请求和控制台。

## 加一个事件 / 按钮

1. 在 `packages/contracts/src/telemetry.ts` 的 `TELEMETRY_EVENTS`（或 `TELEMETRY_BUTTONS`）加一行，属性只用上面那几种规则；
2. 在这份文档里加一行；
3. 按钮：在 `buttons.ts` 的对照表里加 `data-testid → 编号`，或者直接在按钮上写 `data-track="<编号>"`；
4. 跑 `packages/contracts`、`apps/workstation`、`apps/server` 里 `telemetry` 相关的测试。

---

**English.** Agents Workshop sends a small amount of **anonymous** usage data (page route templates, fixed button IDs,
masked click autocapture that keeps only the event type, a source-code `data-testid`, the tag name and the route template,
task outcome and cost tier, card decision type, error class names). It never sends emails, drafts, customer or product
names, anything you type, URL parameters or error messages. Nothing is sent unless the official desktop build provides
a reporting host (`AGENTSWS_TELEMETRY_HOST`) and the host returns a project key; running from source, tests and
self-hosting send nothing. Four milestones (`app_first_open`, `setup_complete`, `first_task`, `daily_active`) are also sent to
Google Analytics 4 through the same relay, with only the app version, a `CN` market region for Chinese UI and GA4 session
fields. Turn it off in Settings → Data & privacy. The browser only talks to the local server, which
re-checks every event against the allowlist in `packages/contracts/src/telemetry.ts` before forwarding it.
