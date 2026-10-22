---
group: models
order: 30
positions: []
roles: []
---
# 接 OpenAI / Anthropic 兼容服务（Kimi、Ollama、Claude 中转站…）

任何「OpenAI 格式」的服务都能接：Moonshot（Kimi）、通义千问、智谱，以及这台电脑上跑的 Ollama。Agents 工坊要求模型**能看图**，选模型时挑带 vision / VL 的那一款。

要接 OpenAI 本家、Anthropic 或阿里云百炼，各有自己的卡（那里还讲了订阅登录与方案区别），不用走这一张。

## 准备什么

- 你要用的那一家的账号，和它控制台里的一把 API key；
- 它文档里写的「接口地址」（一般以 `/v1` 结尾）。

常用几家的控制台：

- [Moonshot（Kimi）](https://platform.moonshot.cn)
- [通义千问（DashScope）](https://help.aliyun.com/zh/model-studio/)
- [智谱 GLM](https://open.bigmodel.cn)
- [Ollama（本地跑）](https://ollama.com)

## 怎么做

1. 去你要用的那家的控制台，创建一个 API key。
2. 找到它文档里写的「接口地址」（一般以 /v1 结尾）。
3. 回到 Agents 工坊，在「OpenAI 兼容（自定义）」卡上（方案是「自己填地址与 key」）点「填 API key」。表单顶上有几个预设（Moonshot / Kimi、通义千问、智谱 GLM、本机 Ollama），点一下就把地址和一个能看图的模型名填好。
4. 把地址、模型名、key 填进表单；不知道模型名就点「拉取模型列表」挑一个。
5. 点保存，再点「测试」确认能通——三个小勾：连得上 / 文字能回 / 看得懂图。

## 预设的地址

| 预设 | 接口地址 | 默认模型 |
|---|---|---|
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| 本机 Ollama | `http://127.0.0.1:11434/v1` | `llama3.2-vision` |

本机 Ollama 不用 key，但要先在这台电脑上装好 Ollama 并拉下那个模型。

## 思考程度（快 / 标准 / 深度）

地址正好是官方目录认识的那一家（比如 OpenAI 本家、Moonshot 国际 / 国内、OpenRouter、百炼 Token Plan），而且模型名在那一家的目录里，输入框 AI 钮旁边就会出思考程度，怎么传给那一家也照官方来。中转站、自建网关、本机 Ollama、目录里没有的模型名，官方没说它们支持哪几档，就不出这个钮，照原样用。

## 接 Anthropic 兼容服务（Claude 中转站）

有的服务说的是「Anthropic 格式」（Claude 中转站、自建网关最常见），走另一张卡：**「Anthropic 兼容（自定义）」**，方案同样是「自己填地址与 key」。

1. 在中转站建一把 API key。Anthropic 本家的 key 不走这张，走「Anthropic / Claude」卡的「API key」方案。
2. 找到它给的接口地址，填进表单（这张卡不预填地址）。带不带 `/v1` 都行，Agents 工坊会自己补全。
3. 在卡上点「填 API key」，把地址和 key 填进表单，点「拉取模型列表」挑一个；拉不到（有的中转站没开这个口）就手填模型名。
4. 想在输入框的 AI 钮里多放几个模型，在「也在 AI 钮里显示」里勾上；它们会和这条来源排在一组。
5. 点保存，再点「测试」，看到三个小勾就是通了。

几点说明：

- **能力标签只照官方目录**：模型名是 Claude 官方型号（比如 `claude-sonnet-4-5`）的，AI 钮里会显示它的名字、能看图、上下文长度，还能调「快 / 标准 / 深度」；中转站自己起的名字认不出，就不显示这些，也不出思考程度，能不能看图以「测试」为准。官方目录里没写自带联网，所以这一类不标「自带联网」。
- **报错怎么看**：说「API key 不对」就回中转站后台重新复制一把；说「余额不足」就是那边的额度用完了，去充值。
- 协议说明见 [Anthropic Messages 接口说明](https://docs.anthropic.com/en/api/messages)。

## 常见问题

- **测试说看不了图**：换一个能看图的模型再测。
- **价格**：内置价目表认得的模型会自动填价；认不得的可以手填，标了「手动」的价不会被官网刷新覆盖。
- API key 只进这台电脑的加密库，不经 AI、不进日志。
