/**
 * 给 ego（`page.evaluate(表达式)`）用的那一段：采集器打包好的脚本 + 「读一遍这一页」，拼成**一个表达式**，
 * 值就是 {@link PageCapture}（已 JSON 往返，没有 `undefined` / Map）。
 *
 * 走表达式而不是 `<script>` 注入：表达式由浏览器的调试通道求值，不经页面自己的 CSP / Trusted Types，
 * 也不在页面里留下任何节点。脚本里没有点击、没有滚动、没有请求（见 `page/capture.ts` 文件头）。
 *
 * `as_url` **只给本机假页面测试用**：假页面开在 `127.0.0.1` 上，而采集器认的是 `www.youtube.com` 这类地址；
 * 给了它，采集器读到的 `window.location` 就换成这个地址（其余一律是真的 `window`）。正式路径不传。
 */

import type { PageCapture } from './page/capture.js'
import { CREATOR_CAPTURE_PAGE_BUNDLE } from './page-script.generated.js'

export type { PageCapture }

export interface PageScriptInput {
  /** 采集器里兜底说明的语言（缺省跟浏览器）。 */
  lang?: 'zh' | 'en'
  /** 只给本机假页面测试用（见文件头）。 */
  as_url?: string
}

const LOCATION_SHIM = `(real, asUrl) => {
  const loc = new URL(asUrl);
  return new Proxy(real, {
    get(target, key) {
      if (key === "location") return loc;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}`

/** 表达式里放参数的那个记号（ego 脚本按页换成 JSON 参数，见 {@link creatorCapturePageTemplate}）。 */
export const PAGE_ARGS_PLACEHOLDER = '__AGENTSWS_CAPTURE_ARGS__'

let template: string | undefined

/**
 * 表达式的模板：参数那一处是 {@link PAGE_ARGS_PLACEHOLDER}。ego 的只读脚本一趟里可能要读好几页
 * （主页 + 它的 link-in-bio 页），模板只传一次，每页换一次参数。
 */
export function creatorCapturePageTemplate(): string {
  template ??= [
    '((args) => {',
    `const window = args.as_url ? (${LOCATION_SHIM})(globalThis, args.as_url) : globalThis;`,
    CREATOR_CAPTURE_PAGE_BUNDLE,
    'return JSON.parse(JSON.stringify(__agentswsCreatorCapture.capturePage(args.lang ? { lang: args.lang } : {})));',
    `})(${PAGE_ARGS_PLACEHOLDER})`,
  ].join('\n')
  return template
}

/** 拼出交给 `page.evaluate` 的表达式。 */
export function creatorCapturePageExpression(input: PageScriptInput = {}): string {
  const args = {
    ...(input.lang === undefined ? {} : { lang: input.lang }),
    ...(input.as_url === undefined ? {} : { as_url: input.as_url }),
  }
  const json = JSON.stringify(args)
  return creatorCapturePageTemplate().replace(PAGE_ARGS_PLACEHOLDER, () => json)
}
