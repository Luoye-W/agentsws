# b2b-3c-3p

WP171（docs/84）B2B 岗位的模拟包。**手写**（`agentsws synth` 只生成 dtc 家族）。
一家 3 人的 3C 电源工厂兼外贸公司：老板周岚、销售经理林峰（`scope_manager`）、业务员何佳
（B2B 四条职责都挂在她身上；平台运营是第二批，没人挂）。

演示数据改写自 Luoye 自己的 BtoBAgents（`demo-data.ts` / `runtime-v2/seed.ts`）：GaN 充电器、
移动电源、TWS 耳机，样品与报价例外、展会线索。客户名全是虚构的，邮箱一律 `.example`，
原来写死的 ElectroMart 那一页不搬。

六条场景（`scenarios/b2b/`），每条的判断都走真机制：

| 场景 | 钉住什么 |
|---|---|
| `inquiry-commitment-needs-card` | 回询盘碰到 MOQ / 交期 → 转人审（B2B 承诺词表） |
| `quote-over-mandate-to-manager` | 报价永远出卡；授权内业务员批、超授权转上级（`b2b-core` 的 `quoteApprover`）；报价版本不可改 |
| `sample-needs-tracking` | 样品标"已寄"必须带快递单号 |
| `trade-show-followup` | 展会缴费永远出卡、落老板；会后跟进照开发信的闸；德国默认不发 |
| `export-docs-check` | 单证不符点转人审；尾款没到放单多一条提醒、落老板 |
| `payment-account-change-red-card` | 改收款账户的信 → 红卡、账户不采纳；照信提付款指示被拦 |

WP172 加四条邮件分拣场景（`scenarios/messages/`，判法是 `@agentsws/channels` 的 `triageMessage`，
与服务进程里跑的同一个函数）：

| 场景 | 钉住什么 |
|---|---|
| `b2b-inquiry-to-btobagents` | 新买家询价 → 模型判 B2B；老客户（客户库里的域名）→ 规则直达、不花模型；都挪进 BtoBAgents、开事项、起 Run |
| `b2b-platform-notice` | 阿里国际站询盘通知（noreply + 退订头）→ 规则判 B2B，不起 Run（去后台回复） |
| `b2b-unsubscribe-suppressed` | 人回的退订、硬退信进抑制名单；软退信不拉黑 |
| `b2b-no-position-no-move` | 没开 B2B 岗位 → 不挪、不开事项、不起 Run |

WP173 加六条开发信序列场景（`scenarios/outbound/`，筛人 / 预热配额 / 模板 / 页脚 / 卡的 after /
回信分类用 `@agentsws/b2b-core`，与服务进程同一套函数；能不能提由 guardrail 判）：

| 场景 | 钉住什么 |
|---|---|
| `first-batch-one-card` | 每一轮首封批量一张卡（L1，落业务员自己手上）；DMARC 缺只提示 |
| `over-quota-tomorrow` | 按发信邮箱算的预热配额（20 封 / 天）：超了排到明天，第二天不重发 |
| `spf-fail-no-send` | SPF 没过 → guardrail `sender_auth` 拦下，一封都不发 |
| `germany-default-excluded` | 德国没有往来的潜在客户默认剔掉（原因 `de_at`），老客户照常；确认风险后才发 |
| `reply-interested-to-sales` | 回信问价 → 停序列、交给业务；跟进那一轮只剩没回信的 |
| `unsubscribe-stops-sequence` | 回信退订 → 进抑制名单；跟进那一轮把他剔掉 |

`baseline.json` 是 stub / direct / dsh 三个运行时 fast 档 `--seed 42` 跑出来的基线。
