# profiles/agentsws

dsh profile（16 §1）：**"我们这种模式"的技术实体**。

- `package.json` —— `dsh.profile.bundles` 列出组合的 bundle，并把每个 `@deepseek-ai/dsh-*`
  **锁到 0.1.5-rc.1**（不用 `^`：上游预发布期"可自由重命名重组"，浮动版本等于随时炸）。
- `cordis.patch.yml` —— 我们的 patch 层（发行版级决定）。

profile 与 preset 的分工：profile 决定**装哪些包、锁什么版本、打什么补丁**；
preset 决定**一个职责用哪些工具、哪段人设**（`presets/<role_id>/agent.cordis.yml`，
由 `@agentsws/dsh-adapter` 按 RunRequest 生成）。

`agentsws-executor`（公司端）与 `agentsws-personal`（个人端）共用这份 profile 的锁版本；
差别在 bundle（headless vs web-app）与"能不能装第三方代码"（v1 公司端不装，31 §3.5）。

升级 dsh 的流程：改这里的版本 → 跑 `packages/dsh-adapter/test` 的 seam 契约测试 →
全绿才合并（17 §4「任一红 = 不升级」）。
