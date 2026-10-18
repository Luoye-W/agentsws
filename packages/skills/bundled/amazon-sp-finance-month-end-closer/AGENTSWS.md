> 这一本是 Amazon 官方发布的卖家技能 `finance-month-end-closer`，原样收录（amzn/selling-partner-agentic-toolkit，提交 8d90d3b，Apache-2.0，Copyright Amazon.com, Inc. or its affiliates）。下面几条是 Agents 工坊的规矩，与后面的官方正文冲突时以这几条为准。

1. **连上 Amazon 店铺之前，这些工具不在手边。** 官方正文点名的工具（`listings_patchListingsItem`、`fbaInventory_getInventorySummaries`、`sales_getOrderMetrics` 这一类）都来自 Amazon 官方卖家连接。工具清单里没有它们，就照实说「连上 Amazon 店铺后才能做」，再说清楚连上以后能看到什么；不拿网页搜索、浏览器或别的工具硬凑同一个数，也不装作已经查过。
2. **写动作一律出卡：预览 → 人批 → 回读。** 正文里「等卖家输入 approve / CONFIRM」那一步，在这里就是一张卡：卡上写清改哪个 SKU、哪一项、改前 → 改后，人在卡上点了才执行；执行完回读一次，按回读到的结果报，不拿「已受理」当「已生效」。自动化级别只由职责设置决定，这本技能不改变它。
3. **不给定价建议。** 官方「不给定价建议、只照卖家说的价格写」那条照旧：不建议涨价或降价，不评价价格高低；卖家报了具体价格，就照这个数出一张改价卡，一个 SKU 一张。
4. **数字不编。** 只用工具返回的数和卖家亲口给的数；补货量、可售天数、利润一律用公式算（`amazon-inventory`、`unit-economics` 两本），算式写出来。缺的数写「不知道」，不按 0 算、不估一个顶上。
5. **断货线统一按 14 天说。** 说「有断货风险」只按 Amazon 自己的口径：可售天数少于 14 天。官方正文里 7 天 / 21 天的分档只当提前预警，14–21 天说「快到了」，不说「已经有风险」。
6. **兄弟技能的名字。** 官方正文里提到的 `listing-issues`、`stockout-prevention` 这些，在 Agents 工坊都加了 `amazon-sp-` 前缀（例如 `amazon-sp-listing-issues`），要读就用 `read_skill` 按带前缀的名字读。
7. **图表与链接。** 正文让你「渲染一个 HTML 图表」的地方，用表格或工作台自带的图表回答，不另写网页。账户标识（`entityId`、merchant token）只在调工具时用，不写进回答和记录。
8. **只读只解释，税务会计结论交专业人士。** 这本只对 Amazon 这一侧的账，不记账、不报税、不动钱；涉及税、VAT、会计处理的结论，请负责人交给会计或税务顾问定。银行到账只认负责人贴过来的金额和日期，不要账号、不要整份流水。
