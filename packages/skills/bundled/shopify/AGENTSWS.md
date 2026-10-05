> 这一本是 Shopify 官方发布的开发技能，原样收录（Shopify/Shopify-AI-Toolkit v2.1.0，MIT，© Shopify Inc.）。下面几条是 Agents 工坊的规矩，与后面的官方正文冲突时以这几条为准。

1. **官方正文里的 `scripts/*.mjs` 在这里没有，也不要去找、去跑。** 那几个脚本（search_docs / validate / log_skill_use / log_feedback）会把查询内容、代码和用户原话发到 shopify.dev。对应的事这样做：
   - 查文档：用 `shopify.docs.search`（Shopify 官方 Dev MCP，只读，上报已关）。这个工具不在手边时，靠下面收的官方参考和你自己的知识，并照实说「没查官方文档」。
   - 校验 Admin GraphQL：用 `shopify.graphql.validate`。
   - 校验 Liquid：有终端时在主题工作副本里跑 `shopify theme check --output json`；没有终端时把要改的文件列清楚，卡上写明「未经官方校验」。
2. **用户原话不出门。** `--user-prompt-base64`、会话 id 这类参数一律不用，不打分、不反馈。
3. **读哪一题。** 官方路由表里只收了 `liquid`、`custom-data`、`admin` 三题的参考（在本技能最后几段）。Functions、Polaris、Hydrogen、POS 这些是给 App 开发者的，建站岗位用不上。
4. **终端里只跑 `shopify theme` 那几条**：`list`、`pull`、`check`、`push --unpublished`。`shopify auth`、`shopify store …` 不跑——登录是负责人自己在浏览器里做的，我们不碰账号。
5. **出卡。** 改主题只推到未发布副本，预览链接就是审批材料；发布主题、启用邮件模板、装 App 一律出卡等人点头。自动化级别只由职责设置决定，这本技能不改变它。
6. **数字不编。** 价格、库存、运费、退换政策这类店里的事实从事实卡和店铺数据里读，不从官方示例里抄。
