/**
 * WP97：**PowerPoint**（`.pptx`）——**基础版**：一页一页的文字与图片，不是排版还原。
 *
 * 这一栏是三种格式里唯一一个**我们自己解**的。找过的三条路都不通：
 *
 * | 库 | 为什么不用 |
 * |---|---|
 * | `pptxjs` / `PPTXjs` | 要 jQuery + 一串 jQuery 插件，而工作台整棵树没有 jQuery；它还按 `<style>` 注样式，壳的 CSP 挡 |
 * | `pptx-preview` 一类的小包 | 都很新、维护者一人、许可证与产物没法一条条核实到我敢让它读外来文件 |
 * | 官方 `dsh-office-to-pdf` | 就是 #13 那条"不借的体"：LibreOffice 转 PDF，平台包 259 MB |
 *
 * 所以走派工书的兜底：用已经在树里的 JSZip（docx-preview 的依赖，**不多加一个包**）
 * 解 `ppt/slides/slide<N>.xml`，取两样东西：
 *
 * 1. **文字**：每个 `<a:p>` 里的 `<a:t>` 拼成一行（DrawingML 里一段就是一个 `a:p`）；
 * 2. **图片**：`<a:blip r:embed="rIdN">` → 同名 `_rels` 里那条关系 → `ppt/media/...`，
 *    做成 blob URL。
 *
 * **"基础版"的边界要说清**（别让人以为是没画好）：不还原版式与母版（`slideLayout` /
 * `slideMaster` 里的占位符文字**不取**）、不还原位置与字号、不画表格与图表
 * （图表的数据在另一棵 `charts/*.xml` 里）、不画 SmartArt、不放动画、不出演讲者备注。
 * 要的是"这份 PPT 大致讲了什么" —— 真要看版式，按"下载原件"。
 */
import { type ReactNode, useEffect, useState } from 'react'
import { StatusPill, WsCard } from '@/components/design'
import { isRenderTimeout, withDeadline } from '@/components/rail/panels/office/deadline'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useApp } from '@/lib/app-context'

/** DrawingML 的命名空间（`a:t` / `a:p` / `a:blip` 都在这一个里）。 */
const NS_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
/** 关系那一份（`r:embed` 的 `r:` 与 `.rels` 里的 `Relationship`）。 */
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** 一页最多取多少张图——一页放几十张图的 PPT 有，但那一页在抽屉里也看不成。 */
const MAX_IMAGES_PER_SLIDE = 12
/** 最多解多少页。 */
const MAX_SLIDES = 200

export interface SlideData {
  /** 第几页（1 起，按文件名里的数字排，不是按 zip 里的顺序）。 */
  index: number
  lines: string[]
  images: string[]
}

/** `ppt/slides/slide12.xml` → 12；取不到数字的排到最后。 */
function slideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/.exec(path)
  return m?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[1])
}

/** `../media/image1.png` （相对 `ppt/slides/`）→ `ppt/media/image1.png`。 */
export function resolveRelTarget(target: string): string | undefined {
  if (target.startsWith('http://') || target.startsWith('https://')) return undefined
  const parts = `ppt/slides/${target}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.length === 0 ? undefined : out.join('/')
}

/**
 * 解一份 pptx。
 *
 * 动态 `import('jszip')` 与 `DOMParser`：两样都在浏览器里现成，不多拉一个解析器。
 * `DOMParser` 走 `application/xml` 档——**不是** `text/html`：HTML 档会把
 * 外来文件里的标签当页面元素建起来，而我们只想读文本。
 */
async function readSlides(blob: Blob): Promise<SlideData[]> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(blob)
  const parser = new DOMParser()
  const paths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .slice(0, MAX_SLIDES)

  const out: SlideData[] = []
  for (const path of paths) {
    const xml = await (zip.file(path)?.async('text') ?? Promise.resolve(''))
    const doc = parser.parseFromString(xml, 'application/xml')
    // 一段（`a:p`）拼成一行：不拼的话每个 run（改过字体的半句话）都会自成一行
    const lines: string[] = []
    for (const p of doc.getElementsByTagNameNS(NS_DRAWING, 'p')) {
      const text = [...p.getElementsByTagNameNS(NS_DRAWING, 't')]
        .map((t) => t.textContent ?? '')
        .join('')
        .trim()
      if (text !== '') lines.push(text)
    }

    // 图片：`r:embed` → `_rels/<同名>.rels` 里那条关系的 Target
    const ids = [...doc.getElementsByTagNameNS(NS_DRAWING, 'blip')]
      .map((b) => b.getAttributeNS(NS_R, 'embed') ?? '')
      .filter((id) => id !== '')
      .slice(0, MAX_IMAGES_PER_SLIDE)
    const images: string[] = []
    if (ids.length > 0) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const relsXml = await (zip.file(`ppt/slides/_rels/${name}.rels`)?.async('text') ??
        Promise.resolve(''))
      const rels = parser.parseFromString(relsXml, 'application/xml')
      const targets = new Map<string, string>()
      for (const rel of rels.getElementsByTagNameNS(NS_RELS, 'Relationship')) {
        const id = rel.getAttribute('Id')
        const target = rel.getAttribute('Target')
        // `External` 的关系指向网上的一张图：不取——这一栏不出网（13 §5）
        if (id !== null && target !== null && rel.getAttribute('TargetMode') !== 'External')
          targets.set(id, target)
      }
      for (const id of ids) {
        const target = targets.get(id)
        const inZip = target === undefined ? undefined : resolveRelTarget(target)
        const entry = inZip === undefined ? null : zip.file(inZip)
        if (entry === null || entry === undefined) continue
        images.push(URL.createObjectURL(await entry.async('blob')))
      }
    }
    out.push({ index: slideNumber(path), lines, images })
  }
  return out
}

export function SlidesView({ blob, onFail }: { blob: Blob; onFail(): void }): ReactNode {
  const { t } = useApp()
  const [slides, setSlides] = useState<SlideData[] | null>(null)
  const [error, setError] = useState<'timeout' | 'broken' | null>(null)
  const [page, setPage] = useState(0)

  useEffect(() => {
    let alive = true
    let made: string[] = []
    setSlides(null)
    setError(null)
    setPage(0)
    withDeadline(readSlides(blob)).then(
      (data) => {
        made = data.flatMap((s) => s.images)
        if (alive) {
          setSlides(data)
          return
        }
        // 已经卸载了才解完：这几个 blob 没人会再看见，当场收掉
        for (const url of made) URL.revokeObjectURL(url)
        made = []
      },
      (e: unknown) => {
        if (!alive) return
        setError(isRenderTimeout(e) ? 'timeout' : 'broken')
        onFail()
      },
    )
    return () => {
      alive = false
      for (const url of made) URL.revokeObjectURL(url)
    }
  }, [blob, onFail])

  if (error !== null)
    return (
      <StatusPill tone="warn" data-testid={`rail-office-${error}`}>
        {t(error === 'timeout' ? 'rail.office.timeout' : 'rail.office.broken')}
      </StatusPill>
    )
  if (slides === null) return <Skeleton className="h-32 w-full" />
  if (slides.length === 0)
    return (
      <StatusPill tone="neutral" data-testid="rail-office-empty">
        {t('rail.office.empty')}
      </StatusPill>
    )

  const current = Math.min(page, slides.length - 1)
  const slide = slides[current] as SlideData

  return (
    <div className="space-y-2" data-testid="rail-office-slides" data-slides={slides.length}>
      <StatusPill tone="info" data-testid="rail-office-slides-basic">
        {t('rail.office.slides_basic')}
      </StatusPill>
      {/* 一页就是一张卡（WP96 的 `WsCard`）：翻页换的是卡里的内容，不换卡 */}
      <WsCard className="space-y-1 px-3 py-2.5" data-testid={`rail-office-slide-${current + 1}`}>
        {slide.lines.length === 0 ? (
          <p className="text-xs text-ws-muted-fg">{t('rail.office.slide_no_text')}</p>
        ) : (
          slide.lines.map((line, i) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: 一页里的行号就是它的身份（只读、不排序、不增删）
              key={`${current}-${i}`}
              className="break-words text-sm leading-6 text-ws-body"
            >
              {line}
            </p>
          ))
        )}
        {slide.images.map((src) => (
          // biome-ignore lint/performance/noImgElement: 这不是 Next.js，`img` 就是这里唯一的办法
          <img
            key={src}
            src={src}
            alt={t('rail.office.image')}
            className="max-w-full rounded-lg border border-ws-line"
          />
        ))}
      </WsCard>
      <div className="flex items-center gap-1 text-xs text-ws-muted-fg">
        <Button
          size="sm"
          variant="ghost"
          disabled={current === 0}
          data-testid="rail-office-page-prev"
          onClick={() => {
            setPage(current - 1)
          }}
        >
          {t('rail.office.prev')}
        </Button>
        <span data-testid="rail-office-page">
          {t('rail.office.page', { page: current + 1, pages: slides.length })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={current >= slides.length - 1}
          data-testid="rail-office-page-next"
          onClick={() => {
            setPage(current + 1)
          }}
        >
          {t('rail.office.next')}
        </Button>
      </div>
    </div>
  )
}
