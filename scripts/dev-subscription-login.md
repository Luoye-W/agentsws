# 本机手工验证：用 ChatGPT / Claude 的订阅登录（WP90，55 §9 Q8）

自动化用例全程不出网（假 OAuth 服务器 + 假 `/codex/responses`），**没有用过任何真账号**。
要用你自己的账号在本机验一遍，照这几步走。

> **先读一遍风险**：第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，
> 可能被限流或封禁；账号只属于你本人，不要在公司共用的机器上登录。
> 2026-03 起有第三方被 429 限流、2026-04 起 `chatgpt.com/backend-api` 对 headless
> 客户端 Cloudflare 403 的记录（docs/55 §9 事实表）。

## 0. 前提

- 这台机器是**个人档**：`AGENTSWS_RUNTIME_MODE` 没设，或设成 `local`。
  设成 `docker` / `hosted` 时整块不可用（这是有意的）。
- 秘密库有密钥：`AGENTSWS_SECRETS_KEY`（64 位十六进制）。桌面壳首次启动会生成；
  直接跑服务进程就自己生成一把：
  ```bash
  export AGENTSWS_SECRETS_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
  ```
- 你的 ChatGPT 账号是 Plus / Pro，或 Claude 账号是 Pro / Max。免费档没有这条路。

## 1. 起服务与工作台

```bash
pnpm dev          # 或 scripts/dev-real.sh（要真连接时）
```

打开工作台 → 设置 → 模型。

## 2. ChatGPT：设备码（推荐）

1. 「OpenAI / ChatGPT」那张卡 → 方案选「用 ChatGPT 订阅登录（Plus / Pro）」。
2. 点「用设备码登录」。卡上会出现一个网址（`https://auth.openai.com/codex/device`）
   和一串码（形如 `ABCD-1234`）。
3. 在手机或另一台电脑上打开那个网址，输入那串码，确认授权。
4. 这一页会自己变成「已登录（账号 acct…xxxx）」，并列出模型（gpt-5.x）。选一个。

**要看的东西**：
- 卡上只显示脱敏账号，看不到完整 id、更看不到 token；
- 事件日志（`GET /v1/events`）里 grep 不到 `sk-`、`eyJ`、`access`、`refresh` 任何一段；
- 秘密库里那一条的 key 名是 `subscription:<你的 person_id>:openai-codex`。

## 3. ChatGPT / Claude：浏览器流

1. 点「用浏览器登录」。服务端会起官方那条流（回调固定 `localhost:1455`），
   并把授权页地址回给工作台，由系统浏览器打开。
2. 在浏览器里完成授权。回调打回 `localhost:1455`，这一页会自己变成「已登录」。
3. **浏览器在另一台机器上**时：卡上会出现「把授权码贴回来」的输入框——
   把浏览器最后跳到的那个 `http://localhost:1455/auth/callback?...` 整个地址贴进去。

> Claude 只有这一条（实测：`pi-ai` 的 anthropic 流没有设备码）。
> 端口 1455 被别的程序占着时浏览器流起不来，先腾出来。

## 4. 真跑一次

设置页把「跑活」的默认模型选成订阅那一条，然后在首页给一个岗位派一件事。跑完看
运行详情的用量：**token 有数、`cost_base` 是 0**（订阅的钱在月费里，不按 token 算）。

## 5. 登出

卡上点「登出」→ 确认。本机那条记录当场销毁；再点「已登录」那一栏应该变回未登录，
下一次运行连不上（这正是本意）。

## 排查

| 现象 | 多半是 |
|---|---|
| 「这台机器是公司档 / 托管档…」 | `AGENTSWS_RUNTIME_MODE` 设成了 `docker` / `hosted` |
| 「这台机器没有秘密库密钥…」 | `AGENTSWS_SECRETS_KEY` 没设 |
| 设备码页面说码无效 | 码有 15 分钟有效期，重新点一次登录 |
| 浏览器流一直转 | 1455 端口被占；或浏览器在别的机器上，改用贴授权码 |
| 跑起来 403 / 429 | 上游对第三方客户端的限流（55 §9 风险那一行），换 API key 那个方案 |
