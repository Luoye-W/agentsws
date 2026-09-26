# 接 OpenAI 兼容服务（Kimi、智谱、Ollama…）

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
5. 境外的服务把「数据驻留」选 global（境外），境内的选 cn（境内）。
6. 点保存，再点「测试」确认能通——三个小勾：连得上 / 文字能回 / 看得懂图。

## 预设的地址

| 预设 | 接口地址 | 默认模型 |
|---|---|---|
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| 本机 Ollama | `http://127.0.0.1:11434/v1` | `llama3.2-vision` |

本机 Ollama 不用 key，但要先在这台电脑上装好 Ollama 并拉下那个模型。

## 常见问题

- **测试说看不了图**：换一个能看图的模型再测。
- **价格**：内置价目表认得的模型会自动填价；认不得的可以手填，标了「手动」的价不会被官网刷新覆盖。
- API key 只进这台电脑的加密库，不经 AI、不进日志。
