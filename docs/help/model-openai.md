# 接 OpenAI / ChatGPT 订阅

两条路：用你已经在付的 ChatGPT 订阅登录，或者去 platform.openai.com 建一把 API key 按量付费。两笔钱互不相干——已经在付 ChatGPT 的钱就不用再买 API 额度。

> 第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，可能被限流或封禁；账号只属于你本人，不要在公司共用的机器上登录。这句话卡上一直显示着。

## 方式一：用 ChatGPT 订阅登录（Plus / Pro）

只在**个人版**（服务跑在你自己电脑上）能用；公司共用的部署上这一条是灰的，会写明为什么。

1. 确认你的 ChatGPT 账号是 Plus 或 Pro（免费档没有这条路）。
2. 在「OpenAI / ChatGPT」卡上选「用 ChatGPT 订阅登录」，点「用设备码登录」——会给你一个网址和一串码。
3. 在手机或另一台电脑上打开那个网址，输入那串码，确认授权。
4. 这一页会自己变成「已登录」，然后选一个模型。令牌到期前会自动续。
5. 要退出就点「登出」：本机那条授权记录当场销毁，之后要重新登录一次。

- [ChatGPT 订阅档位](https://openai.com/chatgpt/pricing)
- [Codex CLI（这条登录路的出处）](https://github.com/openai/codex)

## 方式二：API key（按量计费）

在 platform.openai.com 建一把 key，按 token 付费。

1. 打开 [OpenAI API keys](https://platform.openai.com/api-keys)，登录后进 API keys。
2. 建一把 key，复制那一串（只显示一次）。
3. 在卡上选「API key（按量计费）」，点「填 API key」粘进表单，地址保持预填的那条（`https://api.openai.com/v1`）。
4. 点「拉取模型列表」选一个模型（要能看图的）。
5. 点「测试」确认能通。

API key 只进这台电脑的加密库，不经 AI、不进日志。数据驻留是境外（global）：「数据驻留」设成「只用境内的模型」时它会被拦下。
