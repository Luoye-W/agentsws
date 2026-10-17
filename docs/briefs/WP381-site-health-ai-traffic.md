# WP381 GEO：商品信息机器可读体检、网站技术体检（AI 爬虫 / 原始 HTML）、AI 来源流量（Luoye 10-17：六点都要做；决策 1066）

worktree `../agentsws-wt/wp381-site-health` · 分支 `wp/381-site-health`（从 main 拉；收尾前合最新 main）。先读 `_common.md`（含「先找现成的」：robots / AI 爬虫检查、结构化数据校验、Shopify feed 检查，先查 dsh 官方包、社区插件、成熟开源库，许可证 AGPL/GPL 只参考）、建站 / 网站运营岗位与 Shopify 连接代码、GEO 周报。来源：Aleyda Solis《AI Search Optimization Checklist》（只借思路、注明出处）。WP380 同时在做 GEO 指标与复查；本单产出的数据给 GEO 周报读。

## 要做
1. **商品信息机器可读体检**：Shopify 商品的价格、币种、库存、规格、退换 / 配送政策，在页面、结构化数据（JSON-LD Product / Offer）、商品 feed、各平台之间是否一致、是否带日期；不一致列清单，派给网站运营出审批卡改。另写一节评估「能否进 ChatGPT 购物」（OpenAI 商品 feed 规范），只评估不对接。
2. **网站技术体检**：robots.txt 是否挡了 AI 爬虫（GPTBot、OAI-SearchBot、ChatGPT-User、PerplexityBot、ClaudeBot、Google-Extended、Applebot-Extended、CCBot 等，清单做成数据可更新）；关键事实（价格、卖点、政策）是否在原始 HTML 里（不开 JS 抓一次对比渲染后），只靠 JS 才出现的标出来；结果进建站 / 网站运营的体检报表。
3. **AI 来源流量**：用 Shopify 的来源 / 会话数据（已有连接能取到的），统计从 chatgpt.com、perplexity.ai、gemini.google.com、copilot.microsoft.com、claude.ai 等 AI 来的访问与成交（来源清单可更新），作为保底数字（标「实测」），和 GEO 的引用数并排给周报。
4. 中英文案、界面少字、帮助文档一节。

## 测试
用录好的网页 / robots / JSON-LD / Shopify 样本（不连真实店、不调付费接口）测三项体检；三个运行时 stub / direct / dsh；`scripts/verify-changed.sh`（LC_ALL=en_US.UTF-8）+ 模拟三包。测试用 `--maxWorkers=2 --testTimeout=120000`。截图（浅 / 深）。

## 纪律
不读 .env*；不碰 key / token；不调真实付费接口；不连远程机器、不连真实店；不碰本机 4317；不批量清理；不用 pkill；截图用别的端口、拍完停掉，不写 .review-ready。用户可见文字不提 DataForSEO 等数据商。不合 main、不打 tag、不发版（决策 381）。报告 `docs/briefs/reports/WP381.md`（决策号 1072–1076），白话写。
