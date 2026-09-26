# Connect Alibaba Cloud Model Studio (which plan)

One key calls both Qwen and DeepSeek, with a single bill — if you've used DeepSeek directly, you don't need a separate key from platform.deepseek.com.

Model Studio has **three plans**; pick the one you bought first. Their addresses and keys **don't work across plans** — pick the wrong one and you get a 401 or unexpected charges:

| Plan | When | Key looks like | Billing |
|---|---|---|---|
| Token Plan (subscription) | You bought Token Plan | a dedicated key starting with `sk-sp-` | Credits, not per token |
| Pay as you go (standard) | No subscription | starts with `sk-` | per token |
| Coding Plan (subscription) | You bought Coding Plan | also a dedicated `sk-sp-` key | request quota, not per token |

Token Plan and Coding Plan are separate products and can't be converted — use the one you bought.

## Plan 1: Token Plan (subscription)

1. Turn on Token Plan in the Model Studio console (subscription, metered in Credits).
2. On the Token Plan page get the "dedicated API key" — it starts with `sk-sp-` and is not the pay-as-you-go key.
3. On the "Alibaba Cloud Model Studio" card choose "Token Plan", click "Add API key" and paste the key; keep the prefilled address (the one with token-plan).
4. Click "Fetch model list" to see what your subscription includes, and pick one.
5. Click "Test". Leave the three price boxes at 0 — Credits aren't token money.

It has one address only (Beijing region): `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.

- [Token Plan quick start (dedicated key and address)](https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start)
- [Token Plan overview and Credits](https://help.aliyun.com/zh/model-studio/token-plan-overview)

## Plan 2: pay as you go (standard)

1. Open the [Model Studio console (get an API key)](https://bailian.console.aliyun.com/?tab=model#/api-key), sign in with your Alibaba Cloud account and activate it.
2. Pick the region (Beijing / Singapore) at the top right, open "API-KEY" and click "Create my API-KEY".
3. Copy the key (starts with `sk-`), choose "Pay as you go" on the card, click "Add API key" and paste it.
4. Pick the address by region: Beijing for mainland China, Singapore (international) otherwise — keys don't work across the two.
5. Pick a model → click "Test"; a model name and a latency means it works.

Two addresses:

- Beijing (China, residency cn): `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Singapore (international, residency global): `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`

The standard endpoint has no model list, so the dropdown falls back to the verified list from the built-in price table.

- [Models and pricing](https://help.aliyun.com/zh/model-studio/models)
- [Calling DeepSeek on Model Studio](https://help.aliyun.com/zh/model-studio/deepseek-api)

## Plan 3: Coding Plan (subscription)

1. Turn on Coding Plan in the Model Studio console (subscription, request quota).
2. On the Coding Plan page click "Get API key" — also a dedicated `sk-sp-` key.
3. Choose "Coding Plan" on the card and paste the key; keep the prefilled address (with coding, without compatible-mode).
4. Click "Fetch model list" and pick one of the models in your subscription.
5. Click "Test". Leave the price boxes at 0 — quota isn't token money.

Two addresses: China `https://coding.dashscope.aliyuncs.com/v1`, international `https://coding-intl.dashscope.aliyuncs.com/v1`.

- [Coding Plan and quota](https://help.aliyun.com/zh/model-studio/coding-plan)
- [FAQ (incl. the international address)](https://help.aliyun.com/zh/model-studio/coding-plan-faq)

## FAQ

- **401 invalid_api_key**: usually the key doesn't match the plan (e.g. a Token Plan `sk-sp-` key against the standard endpoint). Switch to the matching plan.
- **How much of my subscription is left**: only the Model Studio console knows; we don't guess.
