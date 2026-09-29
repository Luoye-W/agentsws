# WP202 WP201 实测发现的几处小问题（开源仓 + 私有仓）

两个 worktree：开源 `../agentsws-wt/wp202-fixes` · `wp/202-fixes`；私有 `../agentsws-cloud-wt/wp202-fixes` · `wp/202-fixes`（都从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP201.md`（含 WP201b 补测一节）、`docs/36`（少字）。

## 要修
1. **「分给同事」点了像没反应**（`apps/workstation/src/pages/org.tsx`、`components/org/positions-tab.tsx`）：向导卡片渲染在页顶，按钮在下方时看不见。改成在被点的那张岗位卡**下方就地展开**（或打开后滚过去并把焦点给第一个选项，二选一，优先就地展开）；取消 / 完成后回到原位。测试钉住。
2. **新建岗位 / 加减职责里仍列出已拆分的「Meta 社媒运营」**：职责清单接口（`RoleSummaryView`）**只加**可选 `superseded_by`，新建与加减职责时过滤掉被取代的职责（已持有的老分配照常显示，迁移由 WP191 启动时做）。测试钉住。
3. **配对插件时没有红人职责**：本机 `/v1/extension/hello` 已知道「这个工作区有没有人持有红人职责」的话，插件面板与工作台「连接 → 浏览器插件」都给一句提示「你还没有红人营销岗位，收进来的人暂时看不到」+ 一个去建岗位的入口（工作台侧跳 `/org` 并打开新建岗位、预填「红人营销」与 YouTube / Instagram 红人两条）。插件侧的提示文案与字段在报告里列给 Fable（插件私有仓这一单不改；hello 只加可选字段）。
4. **公共库浏览接口把缺的 `engagement_rate` 回成 0**（私有仓 `packages/kol-public`）：读的时候认旁表的缺格，缺就不带这一格（或回 null，按契约里这一格是否可选定），不要回 0。补测试。开源侧工作台若显示互动率，缺的显示「—」。

## 纪律
契约只加不改；私有代码不进开源仓；不部署；不读 .env*；不跑批量清理命令；本机 4317 服务别碰。

## 验证
开源：`scripts/verify-changed.sh` + fast 模拟三包 stub + `gen-sdk` / `gen-ontology --check` / `gen-cloud-contract --check` + `open-repo-boundary`；私有：README 门禁（含 smoke-workerd）；截图：分给同事就地展开、新建岗位职责列表（无 Meta 社媒运营）、插件提示；报告 `docs/briefs/reports/WP202.md`（开源）。
