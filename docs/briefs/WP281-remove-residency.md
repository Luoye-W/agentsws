# WP281 删掉「数据不出境」整套（决策 291）

worktree `../agentsws-wt/wp281-noresidency` · 分支 `wp/281-noresidency`（从 main 新起）。

## Luoye 10-09 定（291）
「数据不出境这个限制不要加，所有和数据出不出境相关的全部隐藏或者删掉。」决策 262（不出境工作区生图默认 Seedream）作废。

## 要做
1. **界面**：工作台里所有「数据驻留 / 数据不出境 / 境内可用 / 出境」相关的开关、提示、角标、说明、首次设置里的选项、模型设置里的按驻留标注，全部去掉（`models-panel.tsx`、`lib/i18n.ts`、`lib/api.ts` 等，全仓 grep `residency|不出境|出境|境内` 找全）。教程 / 帮助文案里提到的一并删。
2. **行为**：本机不再发 `X-Agentsws-Residency`（或同名）请求头；本机所有按驻留拦截（`model.blocked_residency`、`residency_blocked` 422 的触发点、research-tools / data-service / meetings / kol-public / model-gateway `image-routing.ts` / gemini-images 里按驻留选或拒的分支）去掉——**一律按「不限制」走**；WP274 里「按驻留选云上默认生图型号」的逻辑删掉（默认型号统一，由云端定）。
3. **数据**：已有工作区里存的驻留设置一律视为不限制；读老设置不报错（字段读到就忽略）。
4. **契约**：`packages/contracts` 里的驻留字段 / 错误码 / 事件类型——能删的删（`residency_blocked`、`model.blocked_residency`、请求头常量），云契约 `gen-cloud-contract --check` 会和私有云对照；私有云同时有一单（WP280）删云端那一侧，两边按同一口径：**错误码先保留在契约里标 deprecated、不再产生**（避免老客户端解析崩），其余删。照这个口径做并在报告里列清删了什么、保留了什么。
5. **测试**：删掉 / 改掉专测驻留的用例；加一条断言：工作台各页面渲染不出现「不出境 / 出境 / 数据驻留」字样；模拟三包基线如有变化说明只变了哪几条。
6. `apps/site` 隐私政策里关于数据驻留选项的句子同步改（不再提供「数据不出境」选项），其余隐私条款不动。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真实付费 API。另有子代理在做 WP278 的合并（已结束开发）——如合并前 main 有新提交，先合 main、`npx tsc -b` 后再重出 gen-sdk / gen-ontology。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；`rg -n "residency|不出境|出境|数据驻留" apps packages packs --glob '!**/dist/**'` 的剩余命中逐条在报告里说明为什么留；报告 `docs/briefs/reports/WP281.md`，要 Luoye 定的事单列、每条附建议。
