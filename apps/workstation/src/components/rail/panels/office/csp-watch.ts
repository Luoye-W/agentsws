/**
 * WP99：**CSP 真拦下来的时候才说一句**。
 *
 * WP97 那一版在面板里挂了一句固定文案（"壳里样式不生效 / 内嵌图片显示不出"）。
 * 那句话有两个毛病：
 *
 * 1. **它在浏览器档也出现**——而浏览器档压根没有壳的那道 CSP，样式好好的、
 *    图片也好好的。一句永远显示的"这里可能画不全"等于没说；
 * 2. WP99 给壳开了 `style-src 'self' 'unsafe-inline'` 与 `img-src 'self' blob: data:`
 *    之后，它在壳里**也**不成立了。
 *
 * 换成这个：浏览器在真的挡下一样东西时会派一个 `securitypolicyviolation` 事件
 * （冒泡到 `document`），我们只在收到它、而且挡的正是样式或图片时才说那一句。
 * 挡不到的时候一个字都不说。
 *
 * **不做的事**：不上报、不落盘、不进事件日志——这个事件里带着被挡资源的 URL，
 * 而那可能是一个 `blob:` 地址（指向用户的文件）。它只在内存里活到面板关掉为止
 * （40 §1.2：第三栏只存结构不存内容）。
 */
import { useEffect, useState } from 'react'

/** 我们只关心这几条被挡——别的（脚本、连接）挡下来是**对的**，不该劝人换个姿势。 */
const WATCHED = ['style-src', 'img-src']

/**
 * 一个 `SecurityPolicyViolationEvent` 里我们唯一读的那一格。
 *
 * 不写 `e instanceof SecurityPolicyViolationEvent`：jsdom 25 里没有这个构造器，
 * 而这段逻辑本身要能测。读一个字符串字段就够了。
 */
function violatedDirective(e: Event): string {
  const directive = (e as { violatedDirective?: unknown }).violatedDirective
  return typeof directive === 'string' ? directive : ''
}

/** 这次被挡的是不是样式 / 图片（`style-src-elem` / `img-src` 这种带后缀的也算）。 */
export function isStyleOrImageViolation(e: Event): boolean {
  const directive = violatedDirective(e)
  return WATCHED.some((d) => directive === d || directive.startsWith(`${d}-`))
}

/**
 * 面板挂着期间有没有样式 / 图片被 CSP 挡下。
 *
 * 一挡就 `true`，之后不再回 `false`：一份文档里十张图被挡，那一句话说一次就够。
 */
export function useCspBlocked(): boolean {
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onViolation = (e: Event): void => {
      if (isStyleOrImageViolation(e)) setBlocked(true)
    }
    document.addEventListener('securitypolicyviolation', onViolation)
    return () => {
      document.removeEventListener('securitypolicyviolation', onViolation)
    }
  }, [])
  return blocked
}
