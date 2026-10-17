/**
 * WP381（决策 1066）：网站 / 商品体检的纯逻辑——AI 爬虫、原始 HTML、商品信息一致性、ChatGPT 购物评估。
 * 抓取、渲染、读店铺都在服务端（`apps/server/src/site-health.ts`），这里只判。
 */
export * from './ai-crawlers.js'
export * from './chatgpt-shopping.js'
export * from './extract.js'
export * from './product-facts.js'
export * from './raw-html.js'
