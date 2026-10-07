# WP251 品牌 / 公司口径修正：AI 上下文品牌名、公司全称归公司、启动品牌挂公司；卡住标记；第④步才算设置完；中文政策门槛

worktree `../agentsws-wt/wp251-brandco` · 分支 `wp/251-brandco`（**WP248 合并后**从 main 新起）。先读 `_common.md`、WP66（每品牌一套连接与设置、跟随公司）、WP240 / WP242 / WP244 / WP248 报告、`apps/server/src/onboarding*.ts`（`onboarding_profile` / `onboarding_profiles` 两张表）、identity（`organizations`、`workspaces.org_id`、`kind: personal | shared`）、AI 运行时品牌上下文（WP121 起「品牌：」那一行）、岗位工作视图分组（WP244 按最近一轮运行分组）、`packages/brand-intake`（政策 200 字门槛）。DECISIONS 91 / 92 / 106 / 119。

## Fable 10-07 Windows 真机看到的数据（只读查的）
- `organizations`：`org_1jrhg264` legal_name = 深圳卢耶科技有限公司（在 Rollout 的设置页改的）。
- `workspaces`：INMO `ws_0llwvcm2` **kind = personal、没有 org_id**；Rollout `ws_19cxxs7l` kind = shared、org_id = org_1jrhg264。
- `onboarding_profiles`：每个 workspace 各存一份 legal_name——INMO 那份还是 "INMO"，Rollout 那份是新名字；另有一张老表 `onboarding_profile`（id=1）也是 "INMO"。
即：**公司全称是公司的属性，却按品牌各存一份；启动品牌（第一个品牌）没挂在公司下面。**

## 要做
1. **公司全称归公司**：legal_name / 公司邮箱后缀 / 可被同事发现 / 公司地址这些公司级字段只存在 organization 上，品牌档案读的时候从公司取；设置页「公司」一节改的是公司（对所有品牌生效），「这个品牌」一节改的是品牌。老数据迁移：以 organization 上的值为准；没有 organization 的老安装，用启动品牌那份建一个。
2. **启动品牌挂到公司**：已有 organization 时，把没有 org_id 的启动品牌 workspace 挂上去（迁移，幂等），kind 口径与加的品牌一致（核对 WP66「跟随公司」与云令牌、WP206 成员额度不受影响）。迁移前后各品牌的连接、岗位、事项、知识库一条不丢（端到端测试用一个模拟真机形状的数据目录）。
3. **（119）AI 上下文的「品牌：」**按这次运行所在的品牌取品牌名（品牌档案 brand_name → workspace.brand.name），公司全称另起一行「公司：」；Rollout 跑 AI 时看到 Rollout + 深圳卢耶科技有限公司。
4. **（91）卡住了用结构化标记**：工具回 not_connected / 缺凭据时，运行时在本轮运行上记一个结构化标记（缺哪个连接），工作视图按它分「卡住了」，不再认 AI 末句；保留末句兜底只给老数据。
5. **（92）加的品牌走完第④步才算设置完**：②做完③④没做就离开，回首页仍拉回它的首次设置（停在上次那一步）。启动品牌口径不变。
6. **（106）政策字数门槛按文字类型分**：中日韩 80 字，其他照旧 200 字符。
7. 每条测试。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器（真机迁移由 Fable 做，迁移前 Fable 会备份数据目录）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；报告 `docs/briefs/reports/WP251.md`（迁移说明、给 Fable 的真机复测点、要 Luoye 定的事单列）。
