/**
 * 标记的 SVG 字符串（静态资产那一档）。
 *
 * 静态一律**一条 `userSpaceOnUse` 渐变铺满整个标记，方块把它切开**（规范 §1.2）。
 * 用默认的 `objectBoundingBox` 的话每块内部都会跑一遍完整渐变，六块长得一模一样——
 * 那是错的。动效才是"每块自己一条渐变"（§3.0），那一档在工作台的
 * `components/design/brand-mark.tsx` 里。
 *
 * 渐变坐标写的是**局部坐标**（14/77 → 79/12），与 rect 自己的 x/y 同一套数字。
 * `userSpaceOnUse` 取的是引用它的元素当时所在的用户空间，换算成画布绝对坐标会让
 * 渐变起止点落到方块范围之外，六块只能各自取到几乎同一个点，整体看起来就是纯色
 * （规范 §4.1 坑 2，`avatar-dark.svg` 2026-08-26 修过的那个）。
 */
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  type BlockGradient,
  blockGradient,
  DEFAULT_IDLE_STYLE,
  EASING,
  GRADIENT_AXIS,
  IDLE_BLINK,
  IDLE_SHEEN,
  IDLE_START_MS,
  IDLE_WAVE,
  IDLE_WAVE_DELAYS_MS,
  IDLE_WAVE_SHEEN,
  IDLE_WAVE_SHEEN_DELAYS_MS,
  type IdleStyle,
  idlePercent,
  MARK_BOX,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  type Stop,
  VIEW_BOX,
} from './geometry.js'

function rects(fill: string | ((i: number) => string), extra?: (i: number) => string): string {
  return ALL_BLOCKS.map(
    (b, i) =>
      `<rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="${typeof fill === 'string' ? fill : fill(i)}"${extra?.(i) ?? ''}/>`,
  ).join('')
}

function gradient(id: string, stops: readonly Stop[]): string {
  const body = stops
    .map((s) => `<stop offset="${s.offset * 100}%" stop-color="${s.color}"/>`)
    .join('')
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${GRADIENT_AXIS.x1}" y1="${GRADIENT_AXIS.y1}" x2="${GRADIENT_AXIS.x2}" y2="${GRADIENT_AXIS.y2}">${body}</linearGradient>`
}

/**
 * 出一张标记 SVG。
 *
 * @param id 渐变的 id。同一个页面里塞两张就得给不同的 id，否则后一张会引用前一张的。
 */
export function markSvg(
  options: {
    stops?: readonly Stop[]
    /** 给了就是单色（印刷、灰度、favicon 的小尺寸、刻蚀），渐变那一段整个不出。 */
    solid?: string
    id?: string
    /**
     * WP195：给了就出一张**自己会动**的待机标记（`<style>` 内联在 SVG 里，不靠外部样式表），
     * 用在云端后台、官网、动态 favicon 这些拿不到工作台 `BrandMark` 组件的地方。
     * 系统开了「少一点动效」时它自己停（SVG 里带着那条 media query）。
     */
    idle?: IdleStyle
  } = {},
): string {
  const id = options.id ?? 'aw-mark'
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX}" fill="none">`
  if (options.solid !== undefined) return `${head}${rects(options.solid)}</svg>`
  const stops = options.stops ?? STOPS_ON_DARK
  if (options.idle !== undefined) {
    // 待机时领头那块会往上 / 右探出外框几个单位：内联用时让它画出框外（当 <img> 用时会被裁，四周留边即可）
    const open = head.replace('fill="none">', 'fill="none" overflow="visible">')
    return `${open}${idleBody(options.idle, id, stops)}</svg>`
  }
  return `${head}<defs>${gradient(id, stops)}</defs>${rects(`url(#${id})`)}</svg>`
}

/** 深底上用的标记：那套亮端点（`#4EA8FF → #2FE0C8 → #FFD84D`）。 */
export const BRAND_MARK_SVG_DARK = markSvg({ stops: STOPS_ON_DARK, id: 'aw-mark-dark' })

/** 浅底上用的标记：压暗端点，否则黄那一头在纸白上几乎消失（§1.2「浅底的坑」）。 */
export const BRAND_MARK_SVG_LIGHT = markSvg({ stops: STOPS_ON_LIGHT, id: 'aw-mark-light' })

/**
 * 单色标记：`currentColor`，颜色由用它的地方说了算。
 *
 * 小于 28px、印刷单色、灰度显示、刻蚀一律用它——再小方块间的缝会并起来，
 * 渐变只剩一团糊（§1.3）。深底该取 `MONO_ON_DARK`，浅底取 `MONO_ON_LIGHT`。
 */
export const BRAND_MARK_SVG_MONO = markSvg({ solid: 'currentColor' })

// ── 待机（WP195）──────────────────────────────────────────────────────

/** 动的块每块自己一条 objectBoundingBox 渐变（§3.0），左下 → 右上。 */
function blockGradients(id: string, stops: readonly Stop[]): string {
  return ALL_BLOCKS.map((b, i) => {
    const g: BlockGradient = blockGradient(b, stops)
    return `<linearGradient id="${id}-b${i}" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="${g.from}"/><stop offset="100%" stop-color="${g.to}"/></linearGradient>`
  }).join('')
}

/**
 * 待机那一段的 CSS：一条 keyframes + 基类 + 「少一点动效」时停。
 *
 * `cls` 是挂在动的元素上的类名，也拿来当 keyframes 的名字——同一页里塞两张不同 id 的
 * 标记不会互相串。工作台 `index.css` 里手写的 `ws-bm-idle-*` 是同一套数字
 * （`apps/workstation/test/brand-idle.test.tsx` 逐个对）。
 */
export function idleCss(style: IdleStyle, cls: string): string {
  const base = `.${cls}{transform-box:fill-box;transform-origin:center;`
  const reduce = `@media (prefers-reduced-motion: reduce){.${cls}{animation:none}}`
  if (style === 'wave-sheen') {
    // 两个类：`cls` 挂在每块那个会抬起的 <g> 上，`cls-band` 挂在亮带上；亮带匀速（linear）
    const w = IDLE_WAVE_SHEEN
    const up = idlePercent(w.riseMs, w.periodMs)
    const down = idlePercent(w.riseMs + w.fallMs, w.periodMs)
    const end = idlePercent(w.sweepMs, w.periodMs)
    const far = Number((MARK_BOX.width * w.travel).toFixed(2))
    const band = `${cls}-band`
    return `${base}animation:${cls} ${w.periodMs}ms ease-in-out infinite both}@keyframes ${cls}{0%{transform:translateY(0)}${up}{transform:translateY(-${w.lift}px)}${down},100%{transform:translateY(0)}}.${band}{transform:translate(-${far}px,${far}px);animation:${band} ${w.periodMs}ms linear ${IDLE_START_MS}ms infinite both}@keyframes ${band}{0%{transform:translate(-${far}px,${far}px)}${end},100%{transform:translate(${far}px,-${far}px)}}@media (prefers-reduced-motion: reduce){.${cls}{animation:none}.${band}{animation:none;opacity:0}}`
  }
  if (style === 'wave') {
    const w = IDLE_WAVE
    const up = idlePercent(w.riseMs, w.periodMs)
    const down = idlePercent(w.riseMs + w.fallMs, w.periodMs)
    return `${base}animation:${cls} ${w.periodMs}ms ease-in-out infinite both}@keyframes ${cls}{0%{transform:translateY(0)}${up}{transform:translateY(-${w.lift}px)}${down},100%{transform:translateY(0)}}${reduce}`
  }
  if (style === 'blink') {
    const k = IDLE_BLINK
    const out = idlePercent(k.outMs, k.periodMs)
    const back = idlePercent(k.outMs + k.backMs, k.periodMs)
    return `${base}animation:${cls} ${k.periodMs}ms ${EASING.lead} ${IDLE_START_MS}ms infinite both}@keyframes ${cls}{0%{transform:translate(0,0)}${out}{transform:translate(${k.dx}px,${k.dy}px)}${back},100%{transform:translate(0,0)}}${reduce}`
  }
  const k = IDLE_SHEEN
  const end = idlePercent(k.sweepMs, k.periodMs)
  const far = MARK_BOX.width
  return `${base}transform:translate(-${far}px,${far}px);animation:${cls} ${k.periodMs}ms ${EASING.transition} ${IDLE_START_MS}ms infinite both}@keyframes ${cls}{0%{transform:translate(-${far}px,${far}px)}${end},100%{transform:translate(${far}px,-${far}px)}}@media (prefers-reduced-motion: reduce){.${cls}{animation:none;opacity:0}}`
}

/** 流光那道亮带：沿对角线、两侧羽化，只在中间 `bandWidth` 那一段里亮。 */
function sheenGradient(
  id: string,
  band: { bandWidth: number; peakOpacity: number } = IDLE_SHEEN,
): string {
  const half = band.bandWidth / 2
  const at = (t: number): string => `${Number((t * 100).toFixed(2))}%`
  return `<linearGradient id="${id}" x1="0" y1="1" x2="1" y2="0"><stop offset="${at(0.5 - half)}" stop-color="#fff" stop-opacity="0"/><stop offset="50%" stop-color="#fff" stop-opacity="${band.peakOpacity}"/><stop offset="${at(0.5 + half)}" stop-color="#fff" stop-opacity="0"/></linearGradient>`
}

function idleBody(style: IdleStyle, id: string, stops: readonly Stop[]): string {
  const cls = `${id}-idle`
  const css = `<style>${idleCss(style, cls)}</style>`
  if (style === 'sheen') {
    // 方块不动，照静态那条规矩：一条 userSpaceOnUse 铺满，六块切开；亮带被六块裁出来
    const clip = `<clipPath id="${id}-clip">${rects('#000')}</clipPath>`
    const band = `<g clip-path="url(#${id}-clip)"><rect class="${cls}" x="${MARK_BOX.x}" y="${MARK_BOX.y}" width="${MARK_BOX.width}" height="${MARK_BOX.height}" fill="url(#${id}-sheen)"/></g>`
    return `${css}<defs>${gradient(id, stops)}${sheenGradient(`${id}-sheen`)}${clip}</defs>${rects(`url(#${id})`)}${band}`
  }
  if (style === 'wave-sheen') {
    // 每块一个会抬起的 <g>：块本身 + 被它自己裁出来的那一份亮带，一起抬——光不会漏到缝里。
    // 六份亮带同一条动画、同一个起点，所以看上去就是一道光。
    const box = `x="${MARK_BOX.x}" y="${MARK_BOX.y}" width="${MARK_BOX.width}" height="${MARK_BOX.height}"`
    const clips = ALL_BLOCKS.map(
      (b, i) =>
        `<clipPath id="${id}-c${i}"><rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}"/></clipPath>`,
    ).join('')
    const groups = ALL_BLOCKS.map(
      (b, i) =>
        `<g class="${cls}" style="animation-delay:${IDLE_START_MS + (IDLE_WAVE_SHEEN_DELAYS_MS[i] ?? 0)}ms"><rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="url(#${id}-b${i})"/><g clip-path="url(#${id}-c${i})"><rect class="${cls}-band" ${box} fill="url(#${id}-sheen)"/></g></g>`,
    ).join('')
    return `${css}<defs>${blockGradients(id, stops)}${sheenGradient(`${id}-sheen`, IDLE_WAVE_SHEEN)}${clips}</defs>${groups}`
  }
  const lead = ALL_BLOCKS.length - 1
  const extra = (i: number): string => {
    if (style === 'blink') return i === lead ? ` class="${cls}"` : ''
    return ` class="${cls}" style="animation-delay:${IDLE_START_MS + (IDLE_WAVE_DELAYS_MS[i] ?? 0)}ms"`
  }
  return `${css}<defs>${blockGradients(id, stops)}</defs>${rects((i) => `url(#${id}-b${i})`, extra)}`
}

/** 深底上的待机标记（默认那一种）：云端后台左上角、官网深色区用它。 */
export const BRAND_MARK_SVG_IDLE_DARK = markSvg({
  stops: STOPS_ON_DARK,
  id: 'aw-idle-dark',
  idle: DEFAULT_IDLE_STYLE,
})

/** 浅底上的待机标记（压暗端点）。 */
export const BRAND_MARK_SVG_IDLE_LIGHT = markSvg({
  stops: STOPS_ON_LIGHT,
  id: 'aw-idle-light',
  idle: DEFAULT_IDLE_STYLE,
})
