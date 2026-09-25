# profiles/agentsws

dsh profile（16 §1）：**"我们这种模式"的技术实体**。

- `package.json` —— `dsh.profile.bundles` 列出组合的 bundle，并把每个 `@deepseek-ai/dsh-*`
  **锁到 0.1.7-rc.2**（WP149；不用 `^`：上游预发布期"可自由重命名重组"，浮动版本等于随时炸）。
- `cordis.patch.yml` —— 我们的 patch 层，**只放锁定**（docs/42 红线 7：上游默认会开、我们必须关的那几行）。
  每一行的 id 由 `packages/dsh-adapter/test/profile-lockdown.test.ts` 对照 `dsh --dump-config-schema`
  导出的配置 schema 校验：id 在当前 dsh 里不存在、或指向的插件换了人，测试就红（WP133）。
- `deepseek-account.on.patch.yml` —— **运行时 patch**（WP134）：只把 `deepseek-account`（官方 DeepSeek 账号登录）
  那一行打开。默认不叠——profile 层那一行仍是关死的；用户在向导 / 设置里选了「用我的 DeepSeek 账号登录」才 `--patch` 叠上。
  钉住"没选关、选了开、别的锁定不动"：`profile-lockdown.test.ts` 的 `OPT_IN` 一组。
- `computer-use.on.patch.yml` —— **运行时 patch**（WP144，docs/80）：把电脑操控两行（`computer-use` 服务 +
  Cua Driver **MCP** 提供方）打开。这两行 dsh-base 里本来没有，由 `cordis.patch.yml` 唯一一处 `insert` 插进来、
  写死 `disabled: true`（`INSERTED_OFF` 表）；用户在设置里打开「电脑操控」、这次运行又批了授权才叠上，
  驱动路径由服务进程经 `AGENTSWS_CUA_DRIVER` 给（数据目录里钉版本 + sha256 的那一份）。native 提供方不挂、不进依赖。

profile 与 preset 的分工：profile 决定**装哪些包、锁什么版本、打什么补丁**；
preset 决定**一个职责用哪些工具、哪段人设**（`presets/<role_id>/agent.cordis.yml`，
由 `@agentsws/dsh-adapter` 按 RunRequest 生成）。

`agentsws-executor`（公司端）与 `agentsws-personal`（个人端）共用这份 profile 的锁版本；
差别在 bundle（headless vs web-app）与"能不能装第三方代码"（v1 公司端不装，31 §3.5）。

升级 dsh 的流程：改这里的版本 → 跑 `packages/dsh-adapter/test` 的 seam 契约测试 →
全绿才合并（17 §4「任一红 = 不升级」）。

## 真接管 dsh 进程时要加的行（占位，WP133 从 `cordis.patch.yml` 挪过来）

锁定之外的发行版配置现在一行都不生效（两档运行时由 `packages/dsh-adapter/src/harness.ts` 自己搭树，
不读这个 profile）。哪天真用 `dsh --profile agentsws` 起跨进程 headless run，再把下面这些写进
`cordis.patch.yml`——写进去之前，`profile-lockdown.test.ts` 会要求它们也进 `LOCKDOWN` 表或另起一张表，
免得锁定和配置又混回一个看不全的文件。

```yaml
- id: system-prompt
  config:
    # persona 由 preset 的 complete 段接管，deployment 前后缀留空
    personaPrefix: ''
    personaSuffix: ''

- id: user-approval
  config:
    # 'ask' 才会走 answerer waterfall；没有 answerer 时 dsh 自己 fail-closed
    policy: ask

# WP132：0.1.7 起 preset 不再按目录扫（`dsh-agent-presets` 整包下线），
# 换成 `dsh-agent-preset-registry` + 一行一个 `dsh-agent-preset` 的声明：
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: company-standard
    - id: preset-company-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: company-standard
        plugins: []
```

为什么锁定不拆成 bundle 的独立 patch 文件：bundle 层读不出来会被**跳过、照样启动**（fail-open），
profile 这一层读不出来才会启动失败（fail-closed）。WP133 实测过，理由写在 `cordis.patch.yml` 文件头。

