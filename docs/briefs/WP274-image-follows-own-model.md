# WP274 生图跟随用户自己的模型：自带 OpenAI / Google key 就用它生图、自定义生图接口、Gemini 生图接入（决策 254 / 255）

worktree `../agentsws-wt/wp274-imgown` · 分支 `wp/274-imgown`（**WP268 合并后**从 main 新起）。先读 `_common.md`、WP127 报告（生图单独一档、`images.ts`、`openai-images.ts`、模型设置里的生图档）、WP268 报告（`ImageProvider.edit`、`generate_image` / `edit_image`、上限、素材库）、模型设置页与模型网关的品牌 / 公司层设置（WP66「跟随公司默认」）、DECISIONS 246–255。

## Luoye 10-08 定
- 不考虑国内直连（用户只连我们云）。
- 用户接的模型带生图就用他自己的：自己的 OpenAI key → GPT Image 2.5（生成 flare、改图 sunburst，型号可配）；自己的 Google key → Nano Banana 2.1（API id 以官方文档为准）；走用户自己的 key、不扣积分。
- 不带生图（如 DeepSeek）或用 Agents 工坊积分 → 生图走云端（WP268 / WP273）。
- 设置里可单独指定一个生图接口（OpenAI 兼容 images 形态，或已支持的厂商），覆盖自动选择。

## 要做
1. **生图提供方解析**：按「单独指定的生图接口 > 文字模型同厂商且带生图 > Agents 工坊云」解析出这一次用谁；结果在模型设置页「生图」一档显示一句「现在用：你的 OpenAI 账号（GPT Image 2.5）/ 你的 Google 账号（Nano Banana 2.1）/ Agents 工坊积分」，可改。跟随品牌 / 公司层设置。
2. **Google 生图接入**：新增 Gemini 生图 provider（生成 + 参考图改图），按官方 REST 形态（查清 Nano Banana 2.1 的端点、参数、宽高比 / 尺寸、多参考图上限、返回格式）；与 `ImageProvider` 接口对齐，`edit` 支持多参考图。
3. **计费口径**：走用户自己的 key 时不预扣积分、不出「超额卡」的积分口径（张数上限仍在）；本机记用量（张数、估算美元）给数据看板。
4. 凭据只经现有原生表单 / 加密库，不新增明文配置。
5. 测试：三种解析路径、单独指定覆盖、Gemini provider（假服务覆盖生成 / 改图 / 错误映射 / 内容安全拒绝的人话）、用自己 key 时不扣积分。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真模型（假服务）；不碰私有仓。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；模型设置页「生图」一档截图；报告 `docs/briefs/reports/WP274.md`。
