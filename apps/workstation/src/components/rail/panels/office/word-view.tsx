/**
 * WP97：**Word**（`.docx`）——`docx-preview` 直接画进一个 DOM 容器。
 *
 * **为什么是 docx-preview 而不是 mammoth**（派工书让二选一，理由在这里）：
 * mammoth 的浏览器包里有 **8 处 `new Function(...)`**（bluebird 的 promise 机器
 * 与 lop 的模板编译各占几处），而壳的 CSP 是 `default-src 'self'`——没有
 * `'unsafe-eval'`，那几句一执行就抛。也就是说 mammoth 在桌面壳里**根本跑不起来**，
 * 这不是"排版差一点"的取舍，是能不能跑的取舍。docx-preview 0.4.0 那一侧：
 * `eval` / `new Function` **零处**，Apache-2.0（与我们同一个许可证），
 * 依赖只有一个 jszip，min 之后 75 KB。
 *
 * **WP99：它的 `<style>` 在壳里不再被挡下。** WP97 那一版里 `style-src` 跟着
 * `default-src 'self'` 回落（不含 `'unsafe-inline'`），于是桌面壳里一份 Word 只剩
 * 结构与文字。Luoye 09-18 定：壳的 CSP 单开 `style-src 'self' 'unsafe-inline'`
 * （只为 Word 排版这一件事；`script-src` 一个字没放宽，理由写在
 * `apps/desktop/src/csp.ts` 顶上）。现在两档一样：
 *
 * | 在哪 | 结果 |
 * |---|---|
 * | 浏览器档 / `vite dev` | 排版基本保留（字号、对齐、表格边框） |
 * | 桌面壳（`apps/desktop/src/csp.ts`，WP99 之后） | 同上 |
 *
 * 容器这边那套自己的排版类**留着**：它是兜底——万一哪天壳的策略又收紧、
 * 或者文档自带的那段 CSS 本身就缺（只有结构没有样式的 docx 很常见），
 * 有它才不至于挤成一坨。
 *
 * **blob URL 的命**：docx-preview 把文档里的图片做成 `URL.createObjectURL(...)`，
 * 而它自己**不回收**。这个组件卸载时把渲染树里所有 `blob:` 开头的 `src` 收一遍
 * `revokeObjectURL`——不收的话，每开一次带图的文档就往标签页上挂几 MB，直到关页面。
 */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { StatusPill, WsCard } from '@/components/design'
import { isRenderTimeout, withDeadline } from '@/components/rail/panels/office/deadline'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'

/**
 * 渲染选项。三条"关掉"都是因为这是一个 380 宽的抽屉，不是一张 A4：
 * 不按页断开、不套页面外框、不画页眉页脚。
 */
const OPTIONS = {
  className: 'docx',
  inWrapper: false,
  breakPages: false,
  ignoreWidth: true,
  ignoreHeight: true,
  ignoreLastRenderedPageBreak: true,
  renderHeaders: false,
  renderFooters: false,
  renderFootnotes: true,
  renderEndnotes: true,
  renderChanges: false,
  // WP99 之后壳的 `img-src` 是 `'self' blob: data:`——两种都放行了，所以这一行
  // 不再是"哪种不被挡"的问题，而是**内存**：base64 内联要多占一倍，而且回收不掉
  useBase64URL: false,
  trimXmlDeclaration: true,
} as const

/** 把渲染树里所有 `blob:` 的图片地址收出来（卸载时逐个 revoke）。 */
function blobUrlsIn(root: HTMLElement): string[] {
  return [...root.querySelectorAll('img')]
    .map((img) => img.getAttribute('src') ?? '')
    .filter((src) => src.startsWith('blob:'))
}

export function WordView({ blob, onFail }: { blob: Blob; onFail(): void }): ReactNode {
  const { t } = useApp()
  const bodyRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'done' | 'timeout' | 'broken'>('loading')

  useEffect(() => {
    let alive = true
    let urls: string[] = []
    const body = bodyRef.current
    const style = styleRef.current
    if (body === null || style === null) return
    setState('loading')
    withDeadline(
      import('docx-preview').then((m) => m.renderAsync(blob, body, style, OPTIONS)),
    ).then(
      () => {
        if (!alive) return
        urls = blobUrlsIn(body)
        // `alt` 是无障碍那一格（读屏软件念的就是它），顺带也是图片万一没载出来时
        // 人唯一看得见的东西。**这不是"被 CSP 挡了"的提示**——那一句改成只在
        // 真挡下来时出现（`office/csp-watch.ts`），不再固定挂着
        for (const img of body.querySelectorAll('img')) img.alt = t('rail.office.image')
        setState('done')
      },
      (e: unknown) => {
        if (!alive) return
        setState(isRenderTimeout(e) ? 'timeout' : 'broken')
        onFail()
      },
    )
    return () => {
      alive = false
      // 先收 blob 再清 DOM：反过来的话 `querySelector` 已经找不到那几个 img 了
      for (const url of urls.length > 0 ? urls : blobUrlsIn(body)) URL.revokeObjectURL(url)
      body.replaceChildren()
      style.replaceChildren()
    }
  }, [blob, onFail, t])

  return (
    <div data-testid="rail-office-word" data-state={state}>
      {state === 'timeout' || state === 'broken' ? (
        <StatusPill tone="warn" data-testid={`rail-office-${state}`}>
          {t(state === 'timeout' ? 'rail.office.timeout' : 'rail.office.broken')}
        </StatusPill>
      ) : null}
      {state === 'loading' ? <Skeleton className="h-32 w-full" /> : null}
      {/* 文档自带的那段 CSS 挂在这里（WP99 之后壳里也生效，见文件头那张表） */}
      <div ref={styleRef} hidden data-testid="rail-office-word-style" />
      {/*
        正文放在一张卡里（WP96 的 `WsCard`），排版类是我们自己的——
        文档自带的那段 CSS 不一定有（只有结构没有样式的 docx 很常见），
        全靠这一行兜底
      */}
      <WsCard className="px-3 py-2.5">
        <div
          ref={bodyRef}
          className="[&_img]:max-w-full [&_p]:my-1 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-ws-line [&_td]:px-1.5 [&_td]:py-1 space-y-1 break-words text-sm leading-6 text-ws-body"
          data-testid="rail-office-word-body"
        />
      </WsCard>
    </div>
  )
}
