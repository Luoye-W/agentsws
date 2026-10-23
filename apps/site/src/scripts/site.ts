/**
 * 全站唯一一段脚本（打包后 2 KB 上下）：明暗切换、标记姿态切换、「为什么」逐级点亮、底座分层进场、下载页按系统选默认。
 * 动效本身全是 CSS；这里只挂类名。系统开了「减少动态效果」时点亮逻辑不挂，页面显示的就是最后一帧。
 * 时长不在这里写：由页面在 <body> 上带过来（出自 `@agentsws/brand`）。
 */
import { looksLikeIntelMac, pickDesktop } from '../lib/downloads.js'

const root = document.documentElement
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
const assembleMs = Number(document.body.dataset.awAssembleMs ?? 1500)
const splitMs = Number(document.body.dataset.awSplitMs ?? 1250)

// 明暗：点一下在明 / 暗之间切，记在本机（只存这一个偏好，不是 Cookie）
for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
  btn.addEventListener('click', () => {
    const set = root.getAttribute('data-theme')
    const dark = set ? set === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
    const next = dark ? 'light' : 'dark'
    root.setAttribute('data-theme', next)
    try {
      localStorage.setItem('aw-theme', next)
    } catch {
      /* 隐私模式存不了就算了 */
    }
  })
}

// 标记：集结播完就把类名拿掉（之后再切姿态不会重播集结）
setTimeout(() => {
  for (const m of document.querySelectorAll('.aw-mark.aw-assemble'))
    m.classList.remove('aw-assemble')
}, assembleMs + 50)

function playSplit(host: Element): void {
  const marks = host.querySelectorAll('.aw-mark')
  if (reduce || host.hasAttribute('data-busy')) return
  if ([...marks].some((m) => m.classList.contains('aw-assemble'))) return
  host.setAttribute('data-busy', '')
  for (const m of marks) m.classList.add('aw-split')
  setTimeout(() => {
    for (const m of marks) m.classList.remove('aw-split')
    host.removeAttribute('data-busy')
  }, splitMs + 50)
}

// 页头标记：悬停播一次「一变一队」再回待机
for (const host of document.querySelectorAll('[data-split-host]')) {
  host.addEventListener('mouseenter', () => playSplit(host))
}

// 页面不在前台就停
document.addEventListener('visibilitychange', () =>
  root.classList.toggle('aw-paused', document.hidden),
)

// 「为什么」：滚到哪一级点亮哪一级（桌面按整屏进度，手机按每级自己的位置）
const stairs = document.getElementById('stairs')
if (stairs && !reduce) {
  const steps = [...stairs.querySelectorAll<HTMLElement>('.stair')]
  const narrow = matchMedia('(max-width: 900px)')
  stairs.classList.add('js')
  let lit = 0
  const update = (): void => {
    const vh = innerHeight
    let n = 0
    if (narrow.matches) {
      steps.forEach((s, i) => {
        if (s.getBoundingClientRect().top < vh * 0.72) n = i + 1
      })
    } else {
      n = Math.max(
        0,
        Math.min(4, Math.floor((vh * 0.82 - stairs.getBoundingClientRect().top) / (vh * 0.16))),
      )
    }
    steps.forEach((s, i) => {
      if (i < n) s.classList.add('lit')
      s.classList.toggle('cur', i === n - 1)
    })
    // 第 4 级点亮那一刻，标记播一次「一变一队」
    if (n >= 4 && lit < 4) {
      const team = steps[3]
      if (team) playSplit(team)
    }
    lit = Math.max(lit, n)
  }
  addEventListener('scroll', update, { passive: true })
  addEventListener('resize', update)
  update()
}

// 底座：进屏时分层从下往上叠
const base = document.querySelector('.base')
if (base && !reduce && 'IntersectionObserver' in window) {
  base.classList.add('anim')
  const io = new IntersectionObserver(
    (es) => {
      if (es.some((e) => e.isIntersecting)) {
        base.classList.add('in')
        io.disconnect()
      }
    },
    { threshold: 0.2 },
  )
  io.observe(base)
}

// 下载页：按访客的系统把首屏按钮换成对应那一个（认不出就保持 M 系列芯片的 Mac）
const primary = document.querySelector<HTMLElement>('[data-os-primary]')
if (primary) {
  const ua = navigator.userAgent
  const want = /Windows/i.test(ua) ? 'win-x64' : null
  if (want) {
    const alt = document.querySelector<HTMLTemplateElement>(`template[data-os="${want}"]`)
    if (alt) primary.replaceChildren(alt.content.cloneNode(true))
    for (const card of document.querySelectorAll('[data-os-card]'))
      card.classList.toggle('sel', card.getAttribute('data-os-card') === want)
  }
}

// WP326（决策 731）：只出 M 系列芯片版——认得出是 Intel Mac 就在首屏按钮下面说一句（认不出就不说）
const intelNote = document.querySelector<HTMLElement>('[data-intel-mac]')
// 先看是不是 Mac 再去问显卡：别的系统上不建 WebGL
if (intelNote && /Macintosh/i.test(navigator.userAgent))
  intelNote.hidden = !looksLikeIntelMac(navigator.userAgent, gpuName())

function gpuName(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null
  } catch {
    return null
  }
}

// WP347（Luoye 10-15）：首页「免费下载」按访客系统直接给安装包（M 系列芯片的 Mac / Windows），按钮上写系统和版本号；
// 手机、平板、Intel Mac、认不出的照旧去下载页。直链跳过了下载页上的首次打开说明，所以按钮下面补一行（WP225 同理）
const dlButtons = document.querySelectorAll<HTMLAnchorElement>('a[data-dl]')
if (dlButtons.length > 0) {
  const ua = navigator.userAgent
  const os = pickDesktop({
    userAgent: ua,
    maxTouchPoints: navigator.maxTouchPoints,
    gpu: /Macintosh/i.test(ua) ? gpuName() : null,
  })
  let swapped = false
  if (os) {
    for (const a of dlButtons) {
      const url = a.getAttribute(`data-dl-${os}`)
      const tpl = a.parentElement?.querySelector<HTMLTemplateElement>(
        `template[data-dl-os="${os}"]`,
      )
      if (!url || !tpl) continue
      a.href = url
      a.replaceChildren(tpl.content.cloneNode(true))
      swapped = true
    }
  }
  if (swapped)
    for (const note of document.querySelectorAll<HTMLElement>(`[data-dl-note="${os}"]`))
      note.hidden = false
}

// 10-23（私有 docs/117）：首页「一天怎么过」截图滑动——标签、左右箭头、小圆点跟着当前那张走；不自动播放
for (const slider of document.querySelectorAll<HTMLElement>('[data-slider]')) {
  const track = slider.querySelector<HTMLElement>('[data-track]')
  if (!track) continue
  const tabs = [...slider.querySelectorAll<HTMLElement>('[data-go]')]
  const dots = [...slider.querySelectorAll('.slider-dots i')]
  const n = track.children.length
  const cur = (): number => Math.round(track.scrollLeft / Math.max(1, track.clientWidth))
  const go = (i: number): void =>
    track.scrollTo({ left: track.clientWidth * Math.max(0, Math.min(n - 1, i)) })
  const sync = (): void => {
    const i = cur()
    for (const [k, t] of tabs.entries()) t.setAttribute('aria-selected', String(k === i))
    for (const [k, d] of dots.entries()) d.classList.toggle('on', k === i)
  }
  for (const t of tabs)
    t.addEventListener('click', (e) => {
      e.preventDefault()
      go(Number(t.dataset.go))
    })
  for (const b of slider.querySelectorAll<HTMLElement>('[data-step]'))
    b.addEventListener('click', () => go(cur() + Number(b.dataset.step)))
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true })
  sync()
}

// 「几句话交代」：按组切（没开脚本时每组都摊开）
for (const box of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...box.querySelectorAll<HTMLElement>('[data-tab]')]
  const panels = [...box.querySelectorAll<HTMLElement>('[data-panel]')]
  const show = (i: number): void => {
    for (const [k, t] of tabs.entries()) t.setAttribute('aria-selected', String(k === i))
    for (const [k, p] of panels.entries()) p.hidden = k !== i
  }
  for (const t of tabs) t.addEventListener('click', () => show(Number(t.dataset.tab)))
  box.classList.add('js')
  show(0)
}
