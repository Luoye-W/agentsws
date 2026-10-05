# WP216 建站岗位装上 Shopify 官方 Liquid 技能（并评估官方 Dev MCP）

worktree `../agentsws-wt/wp216-shopify-skills` · 分支 `wp/216-shopify-skills`（从 main 新起）。先读 `_common.md`、`docs/42`（引第三方评估）、官方功能优先（官方更新了什么尽量跟着用上）、`docs/24`（技能三层）、`packages/skills`（bundled 结构、`THIRD-PARTY-NOTICES`、frontmatter，WP209 加的 display_name / summary / positions）、`packages/roles/roles/site/{shopify-build,shopify-theme,shopify-email,shopify-apps}.yml`（四条职责 `skills: []`）、`upstreams.yml` 与 `scripts/check-upstreams.mjs`（上游登记与每周评估例程）、`docs/59`（建站岗位）。

## 背景（Luoye 10-05）
「我们还有个网站建站的岗位，那个岗位下的建站职责，记得先安装 Shopify 官方的 Liquid skill。」接下来要用它给一家获变形金刚 IP 授权的公司做独立站（TWS 耳机、音响）。

## 要做
1. **找到 Shopify 官方的 Liquid 技能**：查实官方发布的 agent skills（Shopify 官方仓库 / 官方插件市场里的 `shopify-liquid` 及同批技能，以实际查到的为准；只看公开页面与仓库），写清：来源 URL、版本 / 提交、许可证、维护方、内容范围、更新频率。**必须是 Shopify 官方发布的**；第三方仿制的不要。
2. **装进来**（许可证允许原样分发时）：原样放进 `packages/skills/bundled/shopify-liquid/`（或按官方目录名），不改正文；我们的元数据只加在 frontmatter 可选字段或旁注文件里（display_name「Shopify Liquid」、summary、positions: [site]），`THIRD-PARTY-NOTICES` 署名；`upstreams.yml` 登记上游，让每周上游例程能发现新版本、照「官方更新跟着用上」走 docs/42 升级。**许可证不允许原样分发**：不拷，改为「首次使用时从官方源下载到本机技能目录」的装法（校验哈希、记来源），评估写清。
3. **挂到职责**：`shopify-theme`（网页模板）、`shopify-email`（邮件模板）、`shopify-build`（整站搭建）三条的 `skills:` 加上它（`load` 方式按技能大小与用途定：主题 / 邮件按需或常驻，写理由）；`shopify-apps` 视内容决定。同批官方技能里若有与这几条职责直接相关的（如主题开发、Admin API、Polaris、Functions），逐个评估：相关的一并装、不相关的写进报告不装。
4. **评估 Shopify 官方 Dev MCP**（`@shopify/dev-mcp` 或现行名称）：它提供的工具（文档搜索、GraphQL schema 校验、Liquid / 主题校验等）、许可证、会不会出网 / 上报遥测（能否关闭）、在 dsh 里挂 MCP 的方式。相关且安全的话，**接进网页模板 / 邮件模板两条职责的工具面**（照 docs/42 与官方功能优先；遥测关掉；出网清单写进卡）；不适合就写清理由。
5. 技能页（WP209 分组）里它出现在「建站」组，第三栏「设定 → 技能」在这几条职责上能看到它。
6. 测试：技能加载、职责挂载、frontmatter 校验（WP209 那条）、上游登记一致（`check-upstreams --check`）；如接了 Dev MCP，用替身测工具挂载与关遥测，不连真网。

## 纪律
只用 Shopify 官方发布的东西；许可证不兼容不拷原文；不读 .env*；不用上下文里的密钥；不跑批量清理命令；本机 4317 服务别碰；WP215 在并行改服务端装配，冲突两边都留。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 stub（零漂移）+ `gen-ontology --check` + `check-upstreams --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP216.md`（含来源 / 许可证 / 评估）。
