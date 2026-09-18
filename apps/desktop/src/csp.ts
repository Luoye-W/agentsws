/**
 * CSP：只允许 self（13 §5「不加载远程内容」）。
 *
 * 页面本身由本地服务进程提供，同源即工作台自己的资源；剩下的全封。
 * 头是主进程在 `onHeadersReceived` 里**覆盖**上去的，即使服务端忘了发也有这一道。
 *
 * ## WP99：在 `default-src 'self'` 之上只加两条（Luoye 09-18 定）
 *
 * WP97 的 Office 预览撞上了 CSP 的**回落规则**——没写的指令一律回落到
 * `default-src`，于是 `default-src 'self'` 一口气管住了四样东西。那一版把四样
 * 全认了（Word 退成"结构 + 文字"、内嵌图片显示不出来），并把「要不要开」
 * 留给 Luoye。现在定下来：**开两条，不开第三条**。
 *
 * | 加的 | 为了什么 | 为什么风险可接受 |
 * |---|---|---|
 * | `style-src 'self' 'unsafe-inline'` | Word 的排版（`docx-preview` 把 docx 的样式写成 `<style>` 与内联 `style=`，不开这条，一份 Word 在壳里是一堆没有字号、没有缩进、没有表格线的段落） | CSS 不执行脚本。剩下的攻击面是「样式注入」：改版面、盖按钮、用 `background-image` 的 URL 外带一点信息——**前两样这里不成立**（第三栏是只读预览，没有可点的东西被盖到），第三样被 `default-src 'self'` 的 `img-src` 挡住（外域 URL 取不出去，见下一行：我们只加 `blob:` 与 `data:`，**没有加任何外域**） |
 * | `img-src 'self' blob: data:` | 文档里内嵌的图片（Word 里的截图、PPT 每页的图）。这些图是从用户自己上传的那份文件里解出来的，在浏览器里是一个 `blob:` URL | `blob:` 与 `data:` **都是同源、纯本地**的东西：前者是这个页面自己 `createObjectURL` 出来的，后者是内联字节。两个都不发起一次网络请求，所以「让内容决定去哪取数」这件事不存在——而那正是 `img-src` 真正防的东西 |
 *
 * **`script-src` 一个字都不放宽**（既不给 `'unsafe-eval'` 也不给 `'unsafe-inline'`）：
 * 它才是唯一能把「一份外来文件」变成「在工作台同源里跑的代码」的那条线。
 * 上面两条之所以敢开，就是因为它没开——没有脚本执行面，样式与图片能做的
 * 事就止于「画得不好看」。`connect-src` / `worker-src` 同样**不动**（它们仍然
 * 跟着 `default-src 'self'` 回落）：前者管"能往哪发请求"，后者一开就等于
 * 又给了一条执行线。
 *
 * 三种格式的解析仍然全在主线程上、仍然配着那道 5 秒的闸
 * （`rail/panels/office/deadline.ts`）——这一条没有因为 CSP 放宽而改变。
 */

/** WP99：为 Word 排版开的那一条（理由见文件顶上）。 */
export const STYLE_SRC = "style-src 'self' 'unsafe-inline'"

/** WP99：为文档内嵌图片开的那一条；`blob:` / `data:` 都不出网。 */
export const IMG_SRC = "img-src 'self' blob: data:"

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  STYLE_SRC,
  IMG_SRC,
  // 下面这四条与 WP16 一字未改。`script-src` 故意不出现在这张表里——
  // 不写 = 回落到 `default-src 'self'`，那正是我们要的（没有 unsafe-*）
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** 大小写不敏感地去掉已有的 CSP 头，再写上我们这份。 */
export function withCsp(
  headers: Readonly<Record<string, string[] | string>>,
  policy: string = CONTENT_SECURITY_POLICY,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only')
      continue
    out[key] = Array.isArray(value) ? [...value] : [value]
  }
  out['Content-Security-Policy'] = [policy]
  return out
}
