---
positions: []
roles: []
---
# 接 Google Gemini

去 Google AI Studio 建一把 API key：文字用 Gemini，生图自动用同一把 key 的 Nano Banana 2.1。钱从你的 Google 账单走，**不扣 Agents 工坊积分**。

## 方式：API key（按量计费）

这是 Google 官方的 OpenAI 兼容口：地址是 `https://generativelanguage.googleapis.com/v1beta/openai`，填一把 Google 的 key 就能用。

1. 打开 [Google AI Studio（拿 API key）](https://aistudio.google.com/apikey)，用 Google 账号登录。
2. 点「Get API key」→「Create API key」，复制那一串。
3. 在「Google Gemini」卡上点「填 API key」，粘进表单；地址保持预填的那条。
4. 点「拉取模型列表」选一个 Gemini 模型（默认 `gemini-3.8-flash`，能看图），再点「测试」。
5. 生图不用另配：设置 → 模型 →「生图」那一块会写「现在用：你的 Google 账号（Nano Banana 2.1）」。

- [OpenAI 兼容层说明](https://ai.google.dev/gemini-api/docs/openai)
- [价格（含生图按张价）](https://ai.google.dev/gemini-api/docs/pricing)

## 生图那一块

- 出图、拿产品图改图都用 Nano Banana 2.1（`gemini-nano-banana-2.1`），一次最多 10 张参考图。
- 它不认遮罩图：要改哪一块，用一句话说清楚（比如「只换背景，产品不动」）。
- 按 Google 的标价，1K 一张约 0.034 美元、2K 约 0.05 美元。数据看板上「用你自己的账号出图」那一行是估算，真账单以 Google 后台为准。
- 想换成别的生图接口（或者用积分出图），在「生图」那一块单独指定一条就行。

API key 只进这台电脑的加密库，不经 AI、不进日志。数据驻留是境外（global）；这台电脑上不了 Google 的话，生图换成 Agents 工坊积分。
