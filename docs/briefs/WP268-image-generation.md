# WP268 生图接入建站 / 设计：生成 + 参考产品图改图、素材库挑图、传 Shopify 文件挂主题（决策 213）

worktree `../agentsws-wt/wp268-image` · 分支 `wp/268-image`（从 main 新起）。先读 `_common.md`、WP127 报告（生图单独一档：`packages/model-gateway/src/images.ts`、`providers/openai-images.ts`、`ImageProvider` 契约、云端 `/v1/ai/images/generations` 按张扣积分——私有仓 `packages/cloud-entry/src/ai.ts` 只读参考）、设计岗位职责（`packages/roles/roles/design/*.yml`）、建站网页模板（WP253 / WP260 主题工具、`theme_write_file` 只许改 settings / templates / custom-*）、WP261 / WP265 运营工具与 `ShopifyAdmin`（云端代发优先）、知识库 / 素材存放现状、审批卡。

## 背景（Luoye 10-08）
「把生图 AI 接入到 Agents 工坊里还是挺重要的，不然像建站这个很难做好。」Rollout 首页现在横幅图、品牌故事图、主推都是占位，AI 交代里要人自己去后台传图。

## 要做
1. **模型评估（只查公开资料，不调真模型）**：按电商建站需要对比 3–5 家当前主流生图 / 改图模型（文字渲染、参考图保持产品一致、改背景 / 场景图、分辨率与宽高比、单张价格、是否 OpenAI 兼容接口或经 New API 可接、国内可用性、商用条款）。写进报告，给出「默认 1 家 + 备选 1 家」的建议与理由，**由 Luoye 定**；代码按接口抽象，换模型只改配置。
2. **改图能力**：契约 `ImageProvider` 加「参考图改图」（OpenAI 形态 `images/edits` 或等价：输入 1–N 张参考图 + 提示词 + 可选遮罩），网关实现；云端需要的配合（`/v1/ai/images/edits` 转发与按张计费）写成清单留给私有仓下一单，本单先用假云端测。
3. **工具（给设计岗与建站网页模板）**：`generate_image`（提示词、宽高比 / 尺寸、张数≤4、风格备注）、`edit_image`（参考图：品牌素材库里的产品图 / 事项里拖入的图 / 店里商品图，经 `ShopifyAdmin` 只读拿 URL）。结果存进**品牌素材库**（本机数据目录，带来源、提示词、模型、成本），在事项里显示成可挑选的图卡（多张并排、选一张 / 都不要 / 再来一版），**花积分前给预估**；单次运行生图张数与积分设上限（超了出卡问）。
4. **挂到网站**：选中的图经 Shopify 上传到店铺「文件」（`fileCreate`，需要 `write_files` / `read_files` 权限——在报告里列出要给应用 B 补的 scopes，Fable 用 CLI 发新版）→ 拿到 CDN 地址 → 网页模板改 `templates/index.json` / settings 引用（Shopify 主题图片设置可用 `shopify://shop_images/<文件名>`，查清写法）→ 照旧推未发布预览；上传属于改店，**先出审批卡**。
5. **设计岗**：海报 / 社媒图 / 广告图也能用 `generate_image` / `edit_image`，结果进素材库。
6. 测试：假图片接口覆盖生成 / 改图 / 失败 / 超额出卡；素材库存取；挑图卡；上传文件审批 → 执行 → 主题引用 → 推预览的端到端（假 Shopify / 假云端）。

## 纪律
不读 .env*；不跑批量清理命令；本机 4317 服务别碰；不连远程机器；不调真模型、不真去 Shopify / 云端；不碰私有仓（只读参考）。

## 验证
`scripts/verify-changed.sh` + 模拟三包 × stub/direct/dsh + `gen-sdk` / `gen-ontology --check` + `gen-cloud-contract --check` + `open-repo-boundary`；挑图卡与素材库截图；报告 `docs/briefs/reports/WP268.md`（模型评估表与建议、云端配合清单、应用 scopes 补充、要 Luoye 定的事单列）。
