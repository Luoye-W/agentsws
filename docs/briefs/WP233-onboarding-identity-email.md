# WP233 首次设置：第 ② 步「登录邮箱」显示 owner@localhost；「公司邮箱域名」说不清

worktree `../agentsws-wt/wp233-idemail` · 分支 `wp/233-idemail`（从 main 新起）。先读 `_common.md`、`apps/workstation/src/components/onboarding/{business-step,profile-form,ai-step}.tsx`、`apps/server/src/cloud-account.ts`、身份那一套（`packages/contracts/src/identity.ts`、`PUT /v1/me`、owner 身份怎么建）、docs/46 §1、docs/20、docs/36 §7（少字）。注意 WP231 在并行改 ai-step 的注册 / 登录（只碰第 ① 步的云账号卡），你不改那部分。

## 现象（Luoye 10-05，Windows 真机，桌面版 local 模式）
- 第 ① 步用「Agents 工坊的接口」填了邮箱（云账号）。
- 第 ② 步「你的生意」底下有「**登录邮箱：owner@localhost**」（只读）——这是本机模式的内部占位身份，用户看着莫名其妙：「第一步不是已经填过登录邮箱了吗？」
- 后面又有「公司邮箱域名」，Luoye 以为又要填登录邮箱，其实是要一个域名。

## 要做
1. **本机身份跟云账号对齐**：第 ① 步云账号关联成功后，本机负责人（owner）的邮箱改成这个云账号邮箱（走现有改身份的路，记审计；只在当前还是占位 `owner@localhost` 时自动改，用户自己改过的不动；可重复跑）。老工作区启动时同样补一次（已关联云账号 + 还是占位邮箱 → 改）。核实所有用 owner 邮箱当键的地方（会话、成员、分配、审计、邀请）不因改邮箱断链。
2. **第 ② 步那一格**：有云账号 → 显示「你的账号：xxx@…」（只读、一行，和第 ① 步同一个）；没有云账号（用自己的 key / DeepSeek 官方）且还是占位邮箱 → **整格不显示**（本机一个人用不需要它）。不要再出现 `owner@localhost`。
3. **「公司邮箱域名」**：改叫「**公司邮箱后缀**」，占位写「例如 inmoxr.com」，tooltip 一句「同事用这个后缀的邮箱加入时，自动认作同一家公司；可不填」；从云账号邮箱 / 品牌客服邮箱自动带出建议值（公共邮箱如 gmail.com、qq.com、163.com、outlook.com 不带）；输入框只收域名，用户误填整个邮箱时自动截取 @ 后面那段。
4. 「已有邀请码？」那一行保持。
5. 测试：关联云账号后 owner 邮箱被改、占位不再出现；无云账号时那一格不显示；后缀截取与公共邮箱不带出；老工作区补改可重复。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连 Luoye 的 Windows。

## 验证
`scripts/verify-changed.sh` + fast 模拟三包 × stub + `gen-sdk` / `gen-ontology --check` + `open-repo-boundary`；截图第 ② 步（有云账号 / 无云账号两态）；报告 `docs/briefs/reports/WP233.md`。
