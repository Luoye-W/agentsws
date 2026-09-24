# WP143 DeepSeek 图片走 Files API 复用 + 推理内容回传（照官方 dsh-llm-deepseek 移植）

worktree `../agentsws-wt/wp143-ds-files` · 分支 `wp/143-ds-files`（从 main 新起）。先读 `_common.md`、`docs/briefs/reports/WP134.md` §6、
官方 `@deepseek-ai/dsh-llm-deepseek@0.1.7-rc.1` 的 README.zh.md（第 81、95、169、177、205 行附近）与 `lib/` 源码。官方是 MIT，**移植**，文件头写出处。

## Luoye 09-24 定
图片上传复用「肯定要借用」。

## 要做
1. **Files API 复用**：凡是走 DeepSeek **Messages** 口的调用（WP134 的 `deepseekAccountProvider`；第 3 条若改了也包括 API key 那一路），
   图片先 `POST /v1/files` 上传、请求里发 file id；头 `anthropic-beta: files-api-2025-04-14`；`redirect: 'error'`。
   同一张图（按字节哈希）在一次运行 / 一个会话里只传一次，缓存 file id（缓存放内存 + 可选落本机库，**不上云**；过期或 404 就重传）。
   **Files 失败或超时 → 整份请求退回内联 base64，一次请求绝不混用**（照官方）。
2. **推理内容回传**：官方「此前 assistant 轮次的推理内容会原样传回」。WP134 报告 §6 第 2 条说我们没带回、多轮可能 400——照官方补上（签名块原样保存、原样回传），加多轮测试。
3. **评估并（若稳）改 DeepSeek API key 那一路走 Messages**：官方适配器 0.1.7 起只用 Messages。我们用户自带 DeepSeek key 时现在走 OpenAI 兼容 `/chat/completions`。
   改成 Messages 就能一起享受 Files 复用与推理回传。**只动 DeepSeek 这一家**，其他 OpenAI 兼容厂商不碰；三步验证（连通 → 文字 → 看图）照跑。
   拿不准就不改，写进报告。官方积分网关那一路（`AGENTSWS_NEWAPI_BASE_URL`）不在本单。
4. 用量 / 计费：Files 上传不另收积分；报告里写清 token 省了多少的估算（同一张图第二次引用的前后对比）。
5. 上游哨兵：`upstreams.yml` 的 `we_depend_on` 记「移植自 dsh-llm-deepseek 的 Files / 推理回传」，`covered_by` 指到新测试；docs/42 升级流程里加一句「dsh-llm-deepseek 的 Files 行为变了要同步」。

## 验收
- 替身测试：同图两次只上传一次；Files 失败整份退 base64 且不混用；file id 过期重传；推理块多轮原样回传；令牌 / key 只在请求头，不进日志与错误信封（沿用 WP134 的守卫）。
- 不联网、不花钱。

## 验证（审核方全量用）
`vitest run packages/model-gateway apps/server packages/dsh-adapter` + fast 模拟 dtc-3c-3p 三个运行时（应零漂移）。
