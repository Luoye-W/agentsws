/**
 * WP455（docs/110 §3，决策 1434）：「用你的 Chrome 搜 Google」读回来的是 HTML 原文（BrowserSkill `get-html`，
 * 页面脚本跑完之后的 DOM）。这里把它解析成文档对象，再跑桌面壳里**同一个**提取函数
 * （`@agentsws/browser-action/serp` 的 `extractSerp`），交回和内置浏览器那一口一样的 `serp` 形状，
 * 被拦 / 过渡页照旧交给 `detect.ts` 的 `blockOf` 认（状态码拿不到，填 0）。
 *
 * 解析用 `linkedom`（ISC，轻、不跑页面脚本）：只解析、不执行任何脚本、不发请求。
 * 真浏览器的 `innerText` 不含 `<script>` / `<style>` 里的字，`linkedom` 的含——先把正文里这两样去掉，
 * 认验证页那一截正文才和页面里读到的一样（`<head>` 里的不动：过渡页的 `enablejs` 在那里）。
 */
import { extractSerp, type SerpExtract } from '@agentsws/browser-action/serp'
import { parseHTML } from 'linkedom'
import type { OpenResult } from './channel.js'
import { type Block, blockOf } from './detect.js'

/** HTML 原文 → 结果页提取（和桌面壳页面里读出来的同一个形状）。 */
export function serpOfHtml(
  html: string,
  url: string,
  engine: 'google' | 'bing' = 'google',
  limit = 10,
): SerpExtract {
  const { document } = parseHTML(html)
  for (const el of Array.from(document.querySelectorAll('body script, body style, body template')))
    el.remove()
  return extractSerp(
    { engine, limit },
    document as unknown as Parameters<typeof extractSerp>[1],
    url,
  )
}

/** 读回来的一页 → 交给 `blockOf` 的那个形状（状态码拿不到，填 0）。 */
export function openResultOfHtml(
  html: string,
  finalUrl: string,
): Extract<OpenResult, { ok: true }> & { serp: SerpExtract } {
  return { ok: true, status: 0, final_url: finalUrl, serp: serpOfHtml(html, finalUrl) }
}

/** 这一页是不是被拦 / 过渡页 / 同意页（110A 的判法）。 */
export function blockOfHtml(html: string, finalUrl: string): Block | undefined {
  return blockOf(openResultOfHtml(html, finalUrl))
}
