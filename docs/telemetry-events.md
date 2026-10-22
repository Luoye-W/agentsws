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

- 只认清单里的事件名，清单外的一律丢（包括 SDK 自己想发的 `$autocapture`、`$exception`、`$web_vitals`、`$pageleave` 等）；
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
| `$pageview` | 页面（路由模板）变了 | `route` |
| `app_opened` | 打开一次工作台 | — |
| `ui_click` | 点了下面「关键按钮」里的一颗 | `button_id`、`route` |
| `client_error` | 页面报错（错误边界接住的、`window.onerror`、没人接的 Promise 拒绝） | `error_kind`、`error_name`（错误类名，如 `TypeError`）、`scope`、`route` |

### 本机服务发的

| 事件 | 什么时候 | 属性 |
|---|---|---|
| `task_finished` | 一次 AI 运行收尾 | `outcome`（`success` / `failure` / `cancelled`）、`cost_tier`、`cache_tier`、`role_id`、`position_id`、`error_code`、`runtime` |
| `card_decided` | 一张卡被人定了 | `decision`（`approve` / `edit` / `reject` / `other`）、`card_kind`（卡的类型编号，如 `outbound_draft`） |

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
task outcome and cost tier, card decision type, error class names). It never sends emails, drafts, customer or product
names, anything you type, URL parameters or error messages. Nothing is sent unless the official desktop build provides
a reporting host (`AGENTSWS_TELEMETRY_HOST`) and the host returns a project key; running from source, tests and
self-hosting send nothing. Turn it off in Settings → Data & privacy. The browser only talks to the local server, which
re-checks every event against the allowlist in `packages/contracts/src/telemetry.ts` before forwarding it.
