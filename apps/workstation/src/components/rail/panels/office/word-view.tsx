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
 * **它的 `<style>` 在壳里会被挡下**，这一条要说在明处（`style-src` 跟着
 * `default-src 'self'` 回落，不含 `'unsafe-inline'`）：
 *
 * | 在哪 | 结果 |
 * |---|---|
 * | 浏览器档 / `vite dev`（没有壳的那道 CSP） | 排版基本保留（字号、对齐、表格边框） |
 * | 桌面壳（`apps/desktop/src/csp.ts`） | `<style>` 与 `style=` 都不生效，剩下**结构与文字**：段落、列表、表格、图片位置都在，字体字号是我们容器的 |
 *
 * 两档都"看得见内容"，所以这一版就这么交；要让壳里也保留排版，得在壳的 CSP 上
 * 单开 `style-src 'self' 'unsafe-inline'`——那是放宽一道门，要 Luoye 定，不在这个 WP 里动。
 * 容器这边给一套自己的排版类，于是被挡下的那一档也不至于挤成一坨。
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
  // base64 内联的图片会被 CSP 的 `img-src` 一样挡下，而且整份文档要多占一倍内存；
  // blob 至少回收得掉
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
        // 图片被 CSP 挡下时 `alt` 是人唯一看得见的东西，所以给它一句人话
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
      {/* 文档自带的那段 CSS 挂在这里（壳里会被 CSP 挡下，见文件头那张表） */}
      <div ref={styleRef} hidden data-testid="rail-office-word-style" />
      {/*
        正文放在一张卡里（WP96 的 `WsCard`），排版类是我们自己的——
        文档自带的那段 CSS 在壳里会被挡下（见文件头那张表），全靠这一行兜底
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
