# 接 DeepSeek（账户登录 / API key）

国内直连、便宜、够用，没别的偏好就选它。数据在境内。DeepSeek 有两种连法，二选一：

- **官方账户登录**（推荐，默认选中）：不用建 key，用 DeepSeek 账号在浏览器里登录一次，按你账号里的余额扣。
- **官方 API 接口连接**：去 DeepSeek 开放平台建一把 API key 填进来，按量计费。

已经配过 DeepSeek key、还没登过账号的，打开卡片时默认显示 API 那种。

## 方式一：官方账户登录

1. 点「用 DeepSeek 账号登录」——会在浏览器里打开 DeepSeek 的授权页。
2. 在那一页上登录你的 DeepSeek 账号、点同意。
3. 回到 Agents 工坊：显示账号名与余额，接着自动验证三步（连通 → 文字 → 看图）。
4. 钱从你 DeepSeek 账号的余额里扣；要退出就点「登出」。

没看到浏览器？点「没看到浏览器？再打开一次」。登录过期了，卡上会说「登录过期了，点一下重新登录」。

登出时：这台电脑上的登录凭据会删掉，这条模型来源随之停用；正在用这个账号跑的事会先停下——停下的事不会丢，换个模型或重新登录后可以让它重做。

## 方式二：官方 API 接口连接

1. 打开 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)，用手机号注册登录。
2. 左边找到「API keys」，点「创建 API key」。
3. 复制那一串（只显示一次，关掉就看不到了）。
4. 回到 Agents 工坊，在 DeepSeek 官方卡上选「官方 API 接口连接」，点「填 API key」，粘进表单，点保存。
5. 点「测试」——回了模型名和延迟就是通了。

API key 只进这台电脑的加密库，不经 AI、不进日志。

## 余额不足怎么办

- 账户登录那种：卡上出「DeepSeek 账号余额不足」和「去充值」，去 [DeepSeek 开放平台](https://platform.deepseek.com) 充值后再让它接着做。
- API key 那种：用建这把 key 的那个 DeepSeek 账号登录开放平台，充值后再试。

## 相关

- 想用一把 key 同时调通义千问与 DeepSeek：看 [接阿里云百炼](help:model-bailian)。
- 不想自己管 key：看 [Agents 工坊官方接口与积分](help:agentsws-credits)。
