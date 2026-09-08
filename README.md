# agentsws

跨境电商 / 品牌出海公司的开源 Agent 中台（DeepSeek Harness 发行版）。域名 agentsws.com。

**一句话**：把人、Agent、渠道和公司知识接成一套协同系统——开源免费跑在公司本地；KefuAgents / KOLAgents / BtoBAgents 作为付费插件升级同一套职责包。

## 与 DeepSeek Harness 的关系

- 本仓是**独立发行版仓**，计划通过 pnpm 锁定官方 `@deepseek-ai/dsh-*` 包版本（`profiles/agentsws/package.json`，**尚未创建**；目前仓内只有设计文档），**不 fork 内核**。
- 官方仓的 fork（github.com/Luoye-W/agentsws 的 upstream 镜像用途）只用于：给上游提 PR、必要时打补丁、bisect 上游变更。我们的代码不放在那里。
- 所有对 dsh 的调用收口在 `packages/adapter`；业务代码只 import 它。升级 dsh = 改版本号 → 跑适配层契约测试 → 全绿才合并。
- 原则来自 dsh 自己的 `AGENTS.md`："Plugins, not loop changes"；铁律 **Model-visible ⟺ logged**。

## 目录

```
profiles/agentsws/   dsh profile：bundles 版本锁定 + cordis.patch.yml
presets/             职责 preset（kefu / kol / btob / company-standard），一目录一 agent.cordis.yml
packages/
  adapter/           @agentsws/dsh-adapter —— 唯一允许 import dsh 的地方（含契约测试）
  core/              框架无关核心：Backend 角色契约、gates（provenance/guardrail）、fencing、types
  connectors/        渠道与系统连接器：email / whatsapp / feishu / shopify（含贡献给 dsh-channels 的适配器）
  mcp-servers/       公司能力的外部 MCP server：knowledge / shopify / feishu-docs
  services/          协同服务（公司公共层）：identity / data / approval / scheduler / registry / sync
  plugins/           我们的 dsh 插件：approval-answerer / presenters / sync-client / cloud-brain-llm-adapter
apps/
  workstation/       独立工作台前端（经 SDK/ACP 对接 dsh，不复用 dsh 的 packages/client）
  cli/               agentsws 命令：init / doctor / export / import / upgrade
skills/              开源职责 skill（customer-care、kol-outreach、…）
vendor/              fork + vendored 的第三方 dsh 插件（dsh-channels、dsh-email、…），带契约测试
evals/               eval 用例（开源版与付费版共用同一套）
docs/                设计文档（开工顺序、换机迁移、架构总览链接）
```

## 文档

讨论与决策（按时间）：
- `docs/01-开工顺序.md`、`docs/02-换机迁移设计.md`
- `docs/03-待细化议题与建议.md` —— 决策索引（每轮结论都追加在末尾）
- `docs/04-职责划分-v1.md`、`docs/05-职责Schema-v1.md`、`docs/06-信息架构、秘书Agent与技能分层.md`
- `docs/07-teamai借鉴与商业化.md`、`docs/08-OpenConnector接入设计.md`、`docs/09-底层框架拆解.md`、`docs/10-框架缺口、参考方案与上游哨兵.md`
- `docs/11-市场与包.md`、`docs/12-开发者路径、建站岗位与命名.md`、`docs/13-流程与定时、检索、解析、凭据与浏览器壳.md`、`docs/16-与DSH生态共存.md`

字段级规范（第一版，契约编号见 09 §2）：
- `14-审批项`（#3）· `15-变更账本与Guardrail`（#4）· `17-运行协议`（#6）· `18-连接器`（#8/#9/#14）· `19-知识对象`（#10）· `20-身份、工作区与Join`（#1）· `21-事件日志与共享数据层`（内核/#16）· `22-模型网关`（#7）· `23-应用包与市场API`（#11/#18）· `24-技能分层与学习回路`（#12）· `25-流程与定时任务`（#17/#13）· `26-模拟场景DSL与合成数据集` · `27-首批职责模板` · `28-API网关与内核` · `29-工作台积木与命名查询`（#15）
- `docs/30-自主决定汇总-待审.md` —— 规范里未经确认的决定
- `docs/31-独立评审回应与修订计划.md` —— 安全与架构修订（生效）
- `docs/32-开源优先路线修正.md` —— **当前生效的路线与第一阶段范围**（开源优先、采用指标、钩子）

架构图（`docs/assets/`）：

![分层总图](docs/assets/架构图-01-分层总图.png)

- `架构图-02-模拟测试回路.png`、`架构图-03-契约矩阵.png`；可编辑源在 Claude Design 画布《agentsws 底层框架》。
前置材料（架构总览、DSH 侦察与生态调研、Commerce Agents 学习报告）在 Luoye 文件夹。

## 许可证与贡献

- 代码、契约、职责包、技能、模拟回路、DevKit 规范：**Apache-2.0**（见 `LICENSE`、`NOTICE`）
- 名称与标志：见 `TRADEMARK.md`（可以 fork，不能叫 agentsws）
- 贡献：DCO，见 `CONTRIBUTING.md`

## 状态

2026-09-09：第一阶段 1a 框架骨架完成——内核、数据层、制度、审核机制、知识记忆、技能、模型网关、替身、模拟回路、API 网关与服务进程已合并，`pnpm simulate --tier fast --pack packs/dtc-3c-3p` 六条场景全部通过（含提示注入、模型停机、预算耗尽），六条不变量全绿。开发方式与合并记录见 `docs/35`。

## 路线

当前生效的路线与第一阶段范围见 `docs/32-开源优先路线修正.md`：开源优先、采用指标、钩子 = 英文客服邮件全接管；接口冻结、实现按切片。同步引擎选型延后（v2）。
