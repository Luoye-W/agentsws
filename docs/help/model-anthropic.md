# 接 Anthropic / Claude 订阅

两条路：用你已经在付的 Claude 订阅登录，或者去 console.anthropic.com 建一把 API key 按量付费。已经在付 Claude 的钱就不用再买 API 额度。

> 第三方工具用订阅登录没有得到 OpenAI / Anthropic 的明文授权，可能被限流或封禁；账号只属于你本人，不要在公司共用的机器上登录。这句话卡上一直显示着。

## 方式一：用 Claude 订阅登录（Pro / Max）

只在**个人版**（服务跑在你自己电脑上）能用。Claude 这条没有设备码，只有「用浏览器登录」。

1. 确认你的 Claude 账号是 Pro 或 Max（免费档没有这条路）。
2. 在「Anthropic / Claude」卡上选「用 Claude 订阅登录」，点「用浏览器登录」——会打开 Claude 的授权页。
3. 授权完成后这一页会自己变成「已登录」；浏览器在别的机器上，就把授权页给的授权码贴回来、点「提交」。
4. 选一个模型。
5. 要退出就点「登出」：本机那条授权记录当场销毁。

- [Claude 订阅档位](https://claude.ai/upgrade)

## 方式二：API key（按量计费）

这是 Anthropic 官方的 OpenAI 兼容口：把地址指到 `api.anthropic.com/v1`、填一把 Anthropic 的 key 就能用。

1. 打开 [Anthropic Console](https://console.anthropic.com/settings/keys)，进 API keys 建一把。
2. 复制那一串，在卡上选「API key（按量计费）」，点「填 API key」粘进表单。
3. 地址保持预填的那条（官方的 OpenAI 兼容口，以 /v1 结尾：`https://api.anthropic.com/v1`）。
4. 选一个模型名（claude-sonnet-4-5 之类）。
5. 点「测试」确认能通。

- [OpenAI SDK 兼容层说明](https://docs.anthropic.com/en/api/openai-sdk)

API key 只进这台电脑的加密库，不经 AI、不进日志。数据驻留是境外（global）。
