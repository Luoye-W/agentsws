---
description: Connect Kimi, Qwen, Zhipu, local Ollama or any OpenAI-format service with a base URL and a key, using a vision model. Claude relays use the Anthropic-compatible card.
---
# Connect an OpenAI- or Anthropic-compatible service (Kimi, Ollama, Claude relays…)

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
5. Save, then click "Test" — three ticks: reachable / text replies / reads images.

## Preset addresses

| Preset | Base URL | Default model |
|---|---|---|
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k-vision-preview` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-plus` |
| Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4v-plus` |
| Local Ollama | `http://127.0.0.1:11434/v1` | `llama3.2-vision` |

Local Ollama needs no key, but Ollama must be installed on this computer with that model pulled.

## Thinking level (Fast / Standard / Deep)

When the address is exactly one the official catalog knows (OpenAI itself, Moonshot international / China, OpenRouter, Bailian Token Plan, for example) and the model name is in that provider's catalog, a thinking-level control appears next to the AI button, and the level is sent the way that provider expects, as the official catalog says. Relays, self-hosted gateways, local Ollama and model names outside the catalog don't declare any levels, so there's no control and they work as before.

## Connect an Anthropic-compatible service (Claude relays)

Some services speak the "Anthropic format" (Claude relays and self-hosted gateways, mostly). They use a separate card: **"Anthropic compatible (custom)"**, with the same "your own URL and key" plan.

1. Create an API key at the relay. An Anthropic key of your own doesn't go here: use the "API key" plan on the "Anthropic / Claude" card.
2. Find its base URL and enter it (this card doesn't prefill one). With or without `/v1` both work; Agents Workshop fills in the rest.
3. On the card, click "Enter API key", fill in the URL and key, then click "Fetch model list" and pick one. If the list can't be fetched (some relays don't offer it), type the model name.
4. To show more models in the AI button under the message box, tick them under "Also show in the AI button"; they're grouped with this source.
5. Save, then click "Test" — three ticks mean it works.

Notes:

- **Capability labels come only from the official catalog**: for official Claude model names (such as `claude-sonnet-4-5`) the AI button shows the model's name, that it reads images, its context length, and offers "Fast / Standard / Deep". Names the relay made up aren't recognized, so none of that is shown and there's no thinking control; whether it reads images is settled by "Test". The official catalog doesn't declare built-in web search, so these models aren't labelled with it.
- **Reading errors**: "API key is wrong" means copy a fresh key from the relay; "balance is too low" means your credit there ran out — top up.
- Protocol details: [Anthropic Messages API](https://docs.anthropic.com/en/api/messages).

## FAQ

- **The test says it can't read images**: switch to a vision-capable model and test again.
- **Prices**: models in the built-in price list are filled in automatically; others can be typed by hand, and prices marked "manual" are never overwritten by a refresh.
- The API key only goes into this computer's encrypted store: never through AI, never into logs.
