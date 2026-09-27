WP155：搜索数据服务商的**替身响应**（不联网）。每份都是照官方文档里的示例响应截短的——
字段名与嵌套照抄，长字符串截短、数组只留一两项、删掉 `xpath` / `rectangle` 这类用不上的格。
出处（2026-09-26 读）：

| 文件 | 出处 |
|---|---|
| `dataforseo-google-serp.json` | https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/ |
| `dataforseo-bing-serp.json` | https://docs.dataforseo.com/v3/serp/bing/organic/live/advanced/ |
| `dataforseo-chatgpt-scraper.json` | https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced/ |
| `dataforseo-perplexity.json` | https://docs.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live/ （示例里 `text` 是 null，这里补了一句，另测 null 那种） |
| `dataforseo-auth-error.json` | https://docs.dataforseo.com/v3/appendix/errors/ （40100） |
| `serpapi-google.json` | https://serpapi.com/search-api 、https://serpapi.com/ai-overview （AI 概览只给 page_token 那一种） |
| `serpapi-ai-overview.json` | https://serpapi.com/google-ai-overview-api |
| `serpapi-bing.json` | https://serpapi.com/bing-search-api |
| `serpapi-copilot.json` | https://serpapi.com/bing-copilot-api |
| `serper-search.json` | https://serper.dev/ 首页示例 |
