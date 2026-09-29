#!/usr/bin/env node
/**
 * WP195：出 `docs/design/brand-motion.html`——品牌标记动效的预览页（单文件、内联、不引外部资源）。
 *
 *     npx tsc -b packages/brand && node scripts/gen-brand-motion-preview.mjs
 *
 * 页面里的 CSS **不是另写的一份**：keyframes 那一整段与明暗两套 `--ws-brand-mark-*` 端点
 * 都是从 `apps/workstation/src/index.css` 原样抠出来的，数字从 `@agentsws/brand` 的 dist 读。
 * 所以预览页里看到的，就是工作台里跑的那一套。标记的 SVG 结构照
 * `apps/workstation/src/components/design/brand-mark.tsx` 的规则拼（同一套类名与延迟）。
 *
 * 页面里那一小段内联脚本只做预览用的事：重播、快进、连拍（把动画冻结在某一时刻）、
 * 页面隐藏时暂停、悬停播一次一变一队。产品里这些是组件自己管的，与它无关。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const b = await import(pathToFileURL(join(ROOT, 'packages/brand/dist/index.js')).href)
const css = readFileSync(join(ROOT, 'apps/workstation/src/index.css'), 'utf8')

/** 从 `at` 起第一个 `{` 到与它配对的 `}`（含）。 */
function braced(at) {
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(at, i + 1)
    }
  }
  throw new Error('index.css 花括号不配对')
}

function brandVars(selector) {
  const block = braced(css.indexOf(`${selector} {`))
  return [...block.matchAll(/(--ws-brand-mark-[\w-]+):\s*([^;]+);/g)].map(
    (m) => `${m[1]}: ${m[2]};`,
  )
}

const light = brandVars(':root')
const dark = brandVars('.dark')
const motionCss = braced(
  css.indexOf('@layer components {', css.indexOf('WP112 · 母品牌标记的四种姿态')),
)

// ── 标记（与 BrandMark 同一套规则）────────────────────────────────────
let seq = 0
const LEAD_INDEX = b.BLOCKS.length

function pose(motion, idle, i) {
  const lead = i === LEAD_INDEX
  if (motion === 'idle') {
    if (idle === 'blink') return lead ? { cls: 'ws-bm-idle-blink' } : {}
    if (idle === 'sheen') return {}
    return {
      cls: 'ws-bm-idle-wave',
      style: `animation-delay:${b.IDLE_START_MS + b.IDLE_WAVE_DELAYS_MS[i]}ms`,
    }
  }
  if (motion === 'assemble') {
    return lead
      ? { cls: 'ws-bm-assemble-lead' }
      : { cls: 'ws-bm-assemble', style: `animation-delay:${b.ASSEMBLE_DELAYS_MS[i]}ms` }
  }
  if (motion === 'breathe') {
    return { cls: 'ws-bm-breathe', style: `animation-delay:-${i * b.BREATHE_PHASE_MS}ms` }
  }
  if (motion === 'split') {
    if (lead) return { cls: 'ws-bm-split-lead' }
    const o = b.SPLIT_OFFSETS[i]
    return {
      cls: 'ws-bm-split',
      style: `animation-delay:${b.SPLIT_FIRST_DELAY_MS + i * b.SPLIT_STEP_MS}ms;--ws-bm-dx:${o.dx}px;--ws-bm-dy:${o.dy}px`,
    }
  }
  return {}
}

function mark(size, motion = 'none', idle = b.DEFAULT_IDLE_STYLE) {
  seq += 1
  const id = `m${seq}`
  const mono = size < b.MIN_GRADIENT_PX
  const active = motion === 'idle' && mono ? 'none' : motion
  const sheen = active === 'idle' && idle === 'sheen'
  const ws = active === 'idle' && idle === 'wave-sheen'
  const perBlock = active !== 'none' && !sheen
  const rect = (blk, attrs) =>
    `<rect x="${blk.x}" y="${blk.y}" width="${b.BLOCK_SIZE}" height="${b.BLOCK_SIZE}" rx="${b.BLOCK_RADIUS}"${attrs}/>`
  let defs = ''
  if (!mono && perBlock) {
    defs = b.ALL_BLOCKS.map(
      (_, i) =>
        `<linearGradient id="${id}-b${i}" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="var(--ws-brand-mark-b${i + 1}-from)"/><stop offset="100%" stop-color="var(--ws-brand-mark-b${i + 1}-to)"/></linearGradient>`,
    ).join('')
  } else if (!mono) {
    const a = b.GRADIENT_AXIS
    const stops = b.STOPS_ON_DARK.map(
      (s, i) => `<stop offset="${s.offset * 100}%" stop-color="var(--ws-brand-mark-${i})"/>`,
    ).join('')
    defs = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}">${stops}</linearGradient>`
  }
  if ((sheen || ws) && !mono) {
    const band = ws ? b.IDLE_WAVE_SHEEN : b.IDLE_SHEEN
    const h = band.bandWidth / 2
    defs += `<linearGradient id="${id}-sheen" x1="0" y1="1" x2="1" y2="0"><stop offset="${(0.5 - h) * 100}%" stop-color="#fff" stop-opacity="0"/><stop offset="50%" stop-color="#fff" stop-opacity="${band.peakOpacity}"/><stop offset="${(0.5 + h) * 100}%" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    defs += ws
      ? b.ALL_BLOCKS.map(
          (blk, i) => `<clipPath id="${id}-c${i}">${rect(blk, ' fill="#000"')}</clipPath>`,
        ).join('')
      : `<clipPath id="${id}-clip">${b.ALL_BLOCKS.map((blk) => rect(blk, ' fill="#000"')).join('')}</clipPath>`
  }
  const box = b.MARK_BOX
  const boxAttrs = `x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`
  const blocks = b.ALL_BLOCKS.map((blk, i) => {
    const fill = mono ? 'currentColor' : `url(#${perBlock ? `${id}-b${i}` : id})`
    if (ws) {
      const delay = b.IDLE_START_MS + b.IDLE_WAVE_SHEEN_DELAYS_MS[i]
      return `<g class="ws-bm-idle-ws" style="animation-delay:${delay}ms">${rect(blk, ` fill="${fill}"`)}<g clip-path="url(#${id}-c${i})"><rect class="ws-bm-idle-ws-band" ${boxAttrs} fill="url(#${id}-sheen)"/></g></g>`
    }
    const p = pose(active, idle, i)
    return rect(
      blk,
      ` fill="${fill}"${p.cls ? ` class="${p.cls}"` : ''}${p.style ? ` style="${p.style}"` : ''}`,
    )
  }).join('')
  const band =
    sheen && !mono
      ? `<g clip-path="url(#${id}-clip)"><rect class="ws-bm-idle-sheen" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="url(#${id}-sheen)"/></g>`
      : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.VIEW_BOX}" width="${size}" height="${size}" fill="none" overflow="visible" aria-hidden="true" data-motion="${active}" data-idle-style="${active === 'idle' ? idle : ''}">${defs ? `<defs>${defs}</defs>` : ''}${blocks}${band}</svg>`
}

// ── 页面 ──────────────────────────────────────────────────────────────
const IDLE = {
  'wave-sheen': {
    name: '波 + 流光',
    note: `隔 ${b.IDLE_WAVE_SHEEN.periodMs / 1000} 秒，一道很淡的光沿渐变方向匀速扫过（${b.IDLE_WAVE_SHEEN.sweepMs / 1000} 秒），扫到哪块，哪块正好轻轻抬起再落下——是同一道光带着方块起伏。`,
  },
  wave: {
    name: '波',
    note: `隔 ${b.IDLE_WAVE.periodMs / 1000} 秒，六块沿渐变方向（左下 → 右上）依次轻轻抬一下，像一道波走过。`,
  },
  sheen: {
    name: '流光',
    note: `隔 ${b.IDLE_SHEEN.periodMs / 1000} 秒，一道很淡的亮光从左下扫到右上，方块本身不动。`,
  },
  blink: {
    name: '眨眼',
    note: `隔 ${b.IDLE_BLINK.periodMs / 1000} 秒，领头那块往右上探一下再弹回来，其余五块不动。`,
  },
}
const SIZES = [24, 40, 96]
const FILM = {
  'wave-sheen': [300, 550, 800, 1000, 1150, 1300, 1500, 1750, 2100],
  wave: [0, 150, 300, 450, 600, 750, 900, 1100, 1400],
  sheen: [0, 250, 500, 625, 750, 875, 1000, 1250, 1500],
  blink: [0, 90, 180, 270, 360, 450, 540, 630, 800],
}

const COMPARE = ['wave-sheen', 'wave', 'sheen']
const compare = (theme) =>
  panel(
    theme,
    COMPARE.map(
      (st) => `<figure>${mark(96, 'idle', st)}<figcaption>${IDLE[st].name}</figcaption></figure>`,
    ).join(''),
  )

const panel = (theme, inner) => `<div class="panel ${theme}">${inner}</div>`
const cell = (size, svg) => `<figure>${svg}<figcaption>${size}px</figcaption></figure>`
const hover = (size, base, idle) =>
  `<span class="hover" data-ms="${b.SPLIT_TOTAL_MS}"><template data-base>${mark(size, base, idle)}</template><template data-split>${mark(size, 'split', idle)}</template>${mark(size, base, idle)}</span>`

function idleRow(style) {
  const tag = style === b.DEFAULT_IDLE_STYLE ? '<span class="pill">默认</span>' : ''
  const sizes = (theme) => panel(theme, SIZES.map((s) => cell(s, mark(s, 'idle', style))).join(''))
  const rail = (theme) =>
    panel(
      theme,
      `<div class="rail">${hover(24, 'idle', style)}<span class="word">Agents 工坊</span></div><p class="tiny">左栏顶部 · 鼠标移上去播一次「一变一队」</p>`,
    )
  return `<section class="cand" id="idle-${style}"><h3>${IDLE[style].name} <code>idleStyle="${style}"</code> ${tag}</h3><p class="note">${IDLE[style].note}</p><div class="pair">${sizes('light')}${sizes('dark')}</div><div class="pair">${rail('light')}${rail('dark')}</div></section>`
}

function filmRow(style) {
  const frames = (theme) =>
    panel(
      theme,
      FILM[style]
        .map(
          (t) =>
            `<figure class="frame" data-t="${b.IDLE_START_MS + t}">${mark(56, 'idle', style)}<figcaption>+${(t / 1000).toFixed(2)}s</figcaption></figure>`,
        )
        .join(''),
    )
  return `<div class="film"><h4>${IDLE[style].name}</h4>${frames('light')}${frames('dark')}</div>`
}

const POSES = [
  ['none', '静态', '就是这个牌子：小图标（单色）、桌面托盘、README'],
  ['assemble', '集结', '这套东西正在起来：冷启动首屏、首次设置第一屏（播一次）'],
  ['breathe', '呼吸', 'Agent 正在替你干活：对话线程、岗位卡运行点（一直在动）'],
  ['split', '一变一队', '一个活做通了，复制成一队：设置完成屏、岗位上岗回执（播一次）'],
]
const poseRow = ([m, name, note]) =>
  `<div class="pose"><h4>${name} <code>${m}</code></h4><p class="tiny">${note}</p><div class="pair replay">${panel('light', cell(72, mark(72, m)))}${panel('dark', cell(72, mark(72, m)))}</div></div>`

const small = (theme) =>
  panel(
    theme,
    [16, 20]
      .map((s) => `<figure>${hover(s, 'none')}<figcaption>${s}px · 单色</figcaption></figure>`)
      .join(''),
  )

const params = [
  [
    '波 + 流光 wave-sheen',
    `${b.IDLE_WAVE_SHEEN.periodMs}ms`,
    `光匀速扫 ${b.IDLE_WAVE_SHEEN.sweepMs}ms（最亮 ${b.IDLE_WAVE_SHEEN.peakOpacity}、宽 ${b.IDLE_WAVE_SHEEN.bandWidth * 100}%）；光到哪块哪块抬 ${b.IDLE_WAVE_SHEEN.lift} 单位（${b.IDLE_WAVE_SHEEN.riseMs}+${b.IDLE_WAVE_SHEEN.fallMs}ms），起步 ${b.IDLE_WAVE_SHEEN_DELAYS_MS.join(' / ')}ms`,
  ],
  [
    '波 wave',
    `${b.IDLE_WAVE.periodMs}ms`,
    `抬 ${b.IDLE_WAVE.lift} 单位，${b.IDLE_WAVE.riseMs}+${b.IDLE_WAVE.fallMs}ms，六块错开 0–${b.IDLE_WAVE.spreadMs}ms`,
  ],
  [
    '流光 sheen',
    `${b.IDLE_SHEEN.periodMs}ms`,
    `扫一次 ${b.IDLE_SHEEN.sweepMs}ms，亮带最亮 ${b.IDLE_SHEEN.peakOpacity}、宽 ${b.IDLE_SHEEN.bandWidth * 100}%`,
  ],
  [
    '眨眼 blink',
    `${b.IDLE_BLINK.periodMs}ms`,
    `领头探出 (${b.IDLE_BLINK.dx}, ${b.IDLE_BLINK.dy}) 单位，${b.IDLE_BLINK.outMs}+${b.IDLE_BLINK.backMs}ms，回弹缓动`,
  ],
]

const pageCss = `
:root { ${light.join(' ')} }
.dark { ${dark.join(' ')} }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: #ECEEEA; color: #263331;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 1080px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 36px 0 8px; }
h3 { font-size: 15px; margin: 0 0 2px; } h4 { font-size: 13px; margin: 0 0 6px; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
.lead, .note { color: #56615c; margin: 0 0 10px; } .tiny { font-size: 12px; color: inherit; opacity: .7; margin: 6px 0 0; }
.bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 0; }
button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; border: 1px solid #c9cfca; background: #fff; cursor: pointer; }
button[aria-pressed="true"] { background: #007B67; border-color: #007B67; color: #fff; }
.pill { font-size: 11px; font-weight: 600; color: #fff; background: #007B67; padding: 1px 8px; border-radius: 999px; vertical-align: 2px; }
.cand, .pose, .film { background: #fff; border-radius: 14px; padding: 16px; margin: 0 0 14px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
.panel { border-radius: 12px; padding: 16px; display: flex; flex-wrap: wrap; align-items: flex-end; gap: 20px; }
.panel.light { background: #F7F8F6; color: #263331; border: 1px solid #ECEFEA; }
.panel.dark { background: #0E100F; color: #F1F4F0; }
figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
figcaption { font-size: 11px; opacity: .6; }
.rail { display: inline-flex; align-items: center; gap: 8px; width: 208px; padding: 4px 8px; }
.word { font-weight: 600; font-size: 14px; }
.hover { display: inline-flex; cursor: default; }
.film .panel { gap: 10px; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; background: #fff; border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ECEFEA; font-size: 13px; }
@media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
`

const script = `
const all = () => document.getAnimations();
let rate = 1;
function setRate(r) { rate = r; for (const a of all()) if (!a.effect?.target?.closest('.frame')) a.playbackRate = r;
  for (const btn of document.querySelectorAll('[data-rate]')) btn.setAttribute('aria-pressed', String(Number(btn.dataset.rate) === r)); }
function freeze() { for (const f of document.querySelectorAll('.frame')) { const t = Number(f.dataset.t);
  for (const a of f.querySelector('svg').getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; } } }
function replay() { for (const box of document.querySelectorAll('.replay .panel')) box.innerHTML = box.innerHTML; setRate(rate); }
document.addEventListener('visibilitychange', () => { for (const s of document.querySelectorAll('svg')) s.classList.toggle('ws-bm-paused', document.hidden); });
for (const h of document.querySelectorAll('.hover')) {
  let busy = false;
  h.addEventListener('mouseenter', () => { if (busy) return; busy = true;
    h.lastElementChild.outerHTML = h.querySelector('template[data-split]').innerHTML; setRate(rate);
    setTimeout(() => { h.lastElementChild.outerHTML = h.querySelector('template[data-base]').innerHTML; setRate(rate); busy = false; }, Number(h.dataset.ms) / rate); });
}
document.querySelector('[data-replay]').addEventListener('click', replay);
for (const btn of document.querySelectorAll('[data-rate]')) btn.addEventListener('click', () => setRate(Number(btn.dataset.rate)));
freeze();
`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>品牌标记动效预览</title>
<!-- WP195 · 由 scripts/gen-brand-motion-preview.mjs 生成，不手改。CSS 原样取自 apps/workstation/src/index.css。 -->
<style>${pageCss}
${motionCss}
</style>
</head>
<body>
<main>
<h1>品牌标记动效预览</h1>
<p class="lead">一直挂在屏幕上的标记改成「待机」：大部分时间一动不动，隔几秒轻轻动一下。四个候选并排，明暗两套、三个尺寸。挂上后先静 ${b.IDLE_START_MS / 1000} 秒才动第一下。「波 + 流光」是 Luoye 09-29 点的结合版，放在最前。系统开了「减少动态效果」时这一页也不会动。</p>
<div class="bar"><button data-rate="1" aria-pressed="true">正常速度</button><button data-rate="4" aria-pressed="false">快进 ×4</button><button data-replay>重播集结 / 一变一队</button></div>

<h2>对比 · 波 + 流光 / 单独的波 / 单独的流光</h2>
<section class="cand" id="compare"><p class="note">三个同时挂上、同时起步，方便并排看。点「快进 ×4」可以不用等。</p><div class="pair">${compare('light')}${compare('dark')}</div></section>

<h2>待机 · 四个候选</h2>
${b.IDLE_STYLES.map(idleRow).join('\n')}

<h2>连拍 · 动的那一下（从第一次动起算）</h2>
${b.IDLE_STYLES.map(filmRow).join('\n')}

<h2>原有四种姿态（不变）</h2>
${POSES.map(poseRow).join('\n')}

<h2>小图标（小于 ${b.MIN_GRADIENT_PX}px 退单色，不挂待机，悬停播一次）</h2>
<div class="pose"><div class="pair">${small('light')}${small('dark')}</div></div>

<h2>参数（@agentsws/brand）</h2>
<table><tr><th>候选</th><th>一轮</th><th>动的那一下</th></tr>${params.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>
</main>
<script>${script}</script>
</body>
</html>
`

const out = join(ROOT, 'docs/design/brand-motion.html')
writeFileSync(out, html)
console.log(`  ${out.slice(ROOT.length + 1)}`)
