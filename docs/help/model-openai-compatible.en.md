# Connect an OpenAI-compatible service (Kimi, GLM, Ollama…)

Any service that speaks the "OpenAI format" works: Moonshot (Kimi), Qwen, Zhipu GLM, and Ollama running on this computer. Agents Workshop requires a model that **can see images**, so pick a vision / VL model.

OpenAI itself, Anthropic and Alibaba Cloud Model Studio each have their own card (which also explains subscription sign-in and plans) — no need to use this one for them.

## What you need

- An account with that provider and an API key from its console;
- The "base URL" from its docs (usually ends in `/v1`).

Consoles of the common ones:

- [Moonshot (Kimi)](https://platform.moonshot.cn)
- [Qwen (DashScope)](https://help.aliyun.com/zh/model-studio/)
- [Zhipu GLM](https://open.bigmodel.cn)
- [Ollama (runs locally)](https://ollama.com)

## Steps

1. Create an API key in the provider's console.
2. Find the base URL in its docs (usually ending in /v1).
3. In Agents Workshop, click "Add API key" on the "OpenAI compatible (custom)" card. The presets at the top of the form (Moonshot / Kimi, Qwen, Zhipu GLM, local Ollama) fill in the URL and a vision-capable model in one click.
4. Fill in URL, model name and key; click "Fetch model list" if you don't know the model name.
5. Set data residency to global for services outside China, cn for services inside China.
6. Save, then click "Test" — three ticks: reachable / text replies / reads images.

## Preset addresses

| Preset | Base URL | Default model |
|---|---|---|
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| Local Ollama | `http://127.0.0.1:11434/v1` | `llama3.2-vision` |

Local Ollama needs no key, but Ollama must be installed on this computer with that model pulled.

## FAQ

- **The test says it can't read images**: switch to a vision-capable model and test again.
- **Prices**: models in the built-in price list are filled in automatically; others can be typed by hand, and prices marked "manual" are never overwritten by a refresh.
- The API key only goes into this computer's encrypted store: never through AI, never into logs.
