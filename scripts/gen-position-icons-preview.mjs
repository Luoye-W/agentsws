#!/usr/bin/env node
/**
 * WP213：出 `docs/design/icons/position-duty-icons.html`——岗位与职责图标两种画风的预览页
 * （单文件、内联 SVG、不引外部脚本 / 字体 / 图片）。
 *
 *     node scripts/gen-position-icons-preview.mjs [--brand-dir <平台 favicon 目录>]
 *
 * 图标本身在 `docs/design/icons/src/{line,block}.mjs`（全部手画）。平台角标用 WP210 抓进仓库的
 * 官网 favicon：默认读 `apps/workstation/src/assets/brand`（WP210 合并之后就在这里）；
 * 合并之前用 `--brand-dir` 指到 WP210 的 worktree。图片以 data URI 内联进页面，每张只存一份
 * （`<symbol>` + `<use>`），所以页面打开时不发任何请求。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_DUTIES, BLOCK_POSITIONS } from '../docs/design/icons/src/block.mjs'
import { LINE_DUTIES, LINE_POSITIONS } from '../docs/design/icons/src/line.mjs'
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  GRADIENT_AXIS,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  sampleStops,
  VIEW_BOX,
} from '../packages/brand/src/geometry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs/design/icons/position-duty-icons.html')
const argAt = process.argv.indexOf('--brand-dir')
const BRAND_DIR =
  argAt > 0 ? process.argv[argAt + 1] : join(ROOT, 'apps/workstation/src/assets/brand')

// ── 名字从模板里读，不另抄一份 ────────────────────────────────────────
function zhName(file) {
  const m = readFileSync(join(ROOT, 'packages/roles', file), 'utf8').match(
    /^name:\s*\{\s*zh:\s*([^,]+),/m,
  )
  if (!m) throw new Error(`读不到名字：${file}`)
  return m[1].trim()
}
const posName = (id) => zhName(`positions/${id}.yml`)
const dutyName = (id) => zhName(`roles/${id.replace('.', '/')}.yml`)

/** 12 个岗位：10 个模板 + 负责人 / 普通成员（这两个不是模板，是 common 那两条的「身份」）。 */
const POSITIONS = [
  'customer-care',
  'kol-marketing',
  'social-media',
  'ads',
  'b2b',
  'pr',
  'web-ops',
  'site',
  'design',
  'dtc-ops',
].map((id) => ({ id, name: posName(id), sub: id }))
POSITIONS.push(
  { id: 'owner', name: '负责人', sub: 'common.owner' },
  { id: 'member', name: '普通成员', sub: 'common.member' },
)

/** 非渠道类职责：专门画一枚。 */
const DUTIES = Object.keys(LINE_DUTIES).map((id) => ({ id, name: dutyName(id), sub: id }))

/**
 * 渠道类职责：岗位图标 + 右下角平台角标。`fav` = WP210 MANIFEST 里的 key；
 * `amazon` 那一家 WP210 没抓到（目录里没有 Amazon 连接），按 docs/36 §8 退回首字母单色徽标。
 */
const CHANNELS = [
  ['kol.youtube', 'kol-marketing', 'youtube_data'],
  ['kol.instagram', 'kol-marketing', 'instagram_graph'],
  ['kol.tiktok', 'kol-marketing', 'tiktok_research'],
  ['kol.x', 'kol-marketing', 'x_api'],
  ['social.facebook', 'social-media', 'facebook_graph'],
  ['social.threads', 'social-media', 'threads_api'],
  ['social.linkedin', 'social-media', 'linkedin_api'],
  ['social.discord', 'social-media', 'discord_bot'],
  ['social.whatsapp', 'social-media', 'whatsapp_business'],
  ['social.telegram-group', 'social-media', 'telegram_bot'],
  ['ads.meta', 'ads', 'meta_ads'],
  ['ads.google', 'ads', 'google_ads'],
  ['ads.tiktok', 'ads', 'tiktok_research'],
  ['pr.reddit', 'pr', 'reddit'],
  ['site.shopify-theme', 'site', 'shopify_admin'],
  ['amz.support', 'customer-care', 'amazon'],
].map(([id, base, fav]) => ({ id, base, fav, name: dutyName(id), sub: id }))

// ── 平台角标：WP210 入库的官网 favicon，每张只内联一份 ─────────────────
const manifestPath = join(BRAND_DIR, 'MANIFEST.json')
if (!existsSync(manifestPath))
  throw new Error(`找不到 ${manifestPath}（WP210 合并前请用 --brand-dir）`)
const MANIFEST = JSON.parse(readFileSync(manifestPath, 'utf8'))

function favSymbol(key) {
  if (key === 'amazon') {
    // docs/36 §8：拿不到官方图就用首字母圆形单色徽标（currentColor），不去别处扒
    return `<symbol id="fav-amazon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M14.6 16.5v-6.1a2.6 2.6 0 0 0-5.1-.6M14.6 13.2c-3.9-.3-5.8.6-5.8 2.1 0 1 .8 1.6 1.9 1.6 1.7 0 3.4-1.2 3.9-2.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></symbol>`
  }
  const entry = MANIFEST.icons[key]
  if (!entry) throw new Error(`MANIFEST 里没有 ${key}`)
  const bytes = readFileSync(join(BRAND_DIR, entry.file))
  const mime = entry.format === 'svg' ? 'image/svg+xml' : 'image/png'
  const uri = `data:${mime};base64,${bytes.toString('base64')}`
  // 原样放进方格：按原比例 contain，不裁、不改色（docs/36 §8 商标三条）
  return `<symbol id="fav-${key}" viewBox="0 0 1 1"><image href="${uri}" width="1" height="1" preserveAspectRatio="xMidYMid meet"/></symbol>`
}

// ── 图标 symbol ─────────────────────────────────────────────────────────
const LINE_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'
const symbols = []
for (const [id, parts] of Object.entries({ ...LINE_POSITIONS, ...LINE_DUTIES }))
  symbols.push(`<symbol id="L-${id}" ${LINE_ATTRS}>${parts.join('')}</symbol>`)
for (const [id, parts] of Object.entries({ ...BLOCK_POSITIONS, ...BLOCK_DUTIES }))
  symbols.push(`<symbol id="B-${id}" viewBox="0 0 24 24">${[parts].flat().join('')}</symbol>`)
for (const key of new Set(CHANNELS.map((c) => c.fav))) symbols.push(favSymbol(key))

// ── 角标几何：每个尺寸一套（像素定，换算回 24 网格）──────────────────────
const SIZES = [16, 20, 24, 32]
/** 角标边长 / 探出图标外框多少 / 与图标之间的缝（都是像素）。 */
const BADGE = {
  16: [10, 1, 1.25],
  20: [11, 1.5, 1.25],
  24: [12, 2, 1.5],
  32: [15, 2, 1.75],
  48: [20, 3, 2],
  96: [40, 6, 3],
}
function badgeBox(size) {
  const [b, o, g] = BADGE[size] ?? BADGE[32]
  const k = 24 / size
  const w = b * k
  const x = 24 + o * k - w
  return { x, w, gap: g * k }
}
for (const size of [...SIZES, 48, 96]) {
  const { x, w, gap } = badgeBox(size)
  const cx = x - gap
  const cw = w + 2 * gap
  symbols.push(
    `<mask id="cut-${size}" maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32"><rect x="-4" y="-4" width="32" height="32" fill="#fff"/><rect x="${cx}" y="${cx}" width="${cw}" height="${cw}" rx="${cw * 0.3}" fill="#000"/></mask>`,
  )
}

/** 一枚图标。`style` = 'L' | 'B'；`fav` 给了就是渠道类（岗位图标 + 角标）。 */
function icon(style, id, size, fav) {
  const open = `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" overflow="visible" aria-hidden="true">`
  if (!fav) return `${open}<use href="#${style}-${id}" width="24" height="24"/></svg>`
  const { x, w } = badgeBox(size)
  return `${open}<g mask="url(#cut-${size})"><use href="#${style}-${id}" width="24" height="24"/></g><use class="fav" href="#fav-${fav}" x="${x}" y="${x}" width="${w}" height="${w}"/></svg>`
}

// ── 品牌标记（左栏小样顶上那枚）：照 @agentsws/brand 的几何与渐变拼 ─────
function mark(size, stops, id) {
  const g = GRADIENT_AXIS
  const st = stops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('')
  const rects = ALL_BLOCKS.map(
    (b) =>
      `<rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="url(#${id})"/>`,
  ).join('')
  return `<svg width="${size}" height="${size}" viewBox="${VIEW_BOX}" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${st}</linearGradient></defs>${rects}</svg>`
}

/** 块面的两种颜色：主体取渐变 30% 处（蓝青之间），点睛取渐变尽头（领头那块的黄）。 */
const TONES = {
  light: { c1: sampleStops(0.3, STOPS_ON_LIGHT), c2: sampleStops(1, STOPS_ON_LIGHT) },
  dark: { c1: sampleStops(0.3, STOPS_ON_DARK), c2: sampleStops(1, STOPS_ON_DARK) },
}

// ── 样式：明暗两套取工作台的 --ws-*（docs/36 §1.1），选中态照左栏 navClass ──────
const CSS = `
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 56px; background: #ECEEEA; color: #263331;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
main { max-width: 1120px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 40px 0 6px; }
h3 { font-size: 14px; margin: 0 0 8px; }
.lead { color: #56615c; margin: 0 0 12px; max-width: 760px; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; }
.t-light { --paper:#F3F5F2; --card:#FFFFFF; --line:#ECEFEA; --ink:#263331; --muted:#6B746F; --brand:#007B67; --brand-ink:#045246; --tint:#E8F3F0; --sidebar:#F8FAF7;
  --c1-on:${TONES.light.c1}; --c2-on:${TONES.light.c2}; --c1-off:#6B746F; --c2-off:#A3ABA6; }
.t-dark { --paper:#0E100F; --card:#171A18; --line:#242825; --ink:#F1F4F0; --muted:#98A29B; --brand:#76FB91; --brand-ink:#B9FFC9; --tint:#173C24; --sidebar:#121513;
  --c1-on:${TONES.dark.c1}; --c2-on:${TONES.dark.c2}; --c1-off:#98A29B; --c2-off:#646D67; }
.t-light, .t-dark { background: var(--card); color: var(--ink); }
.off { color: var(--muted); --ia: currentColor; --c1: var(--c1-off); --c2: var(--c2-off); }
.on { color: var(--brand-ink); --ia: var(--brand); --c1: var(--c1-on); --c2: var(--c2-on); }
.ic { display: block; flex: none; }
.card { background: #fff; border-radius: 16px; padding: 16px; margin: 0 0 14px; box-shadow: 0 1px 2px rgba(20,40,30,.04), 0 8px 24px rgba(20,40,30,.05); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.panel { border-radius: 12px; padding: 14px; }
.t-light.panel { border: 1px solid var(--line); }
.tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: #E8F3F0; color: #045246; margin-left: 6px; vertical-align: 2px; }
/* 总览 */
.ov { display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px 6px; }
.ov figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.ov figcaption { font-size: 12px; color: var(--muted); text-align: center; line-height: 1.3; }
.ov .sm { display: flex; gap: 8px; align-items: center; }
/* 逐枚：四个尺寸 × 未选中 / 选中 */
table.m { width: 100%; border-collapse: separate; border-spacing: 0; }
table.m th { font-size: 12px; font-weight: 600; color: #56615c; text-align: left; padding: 0 8px 6px; }
table.m td { padding: 6px 8px; vertical-align: middle; border-top: 1px solid #ECEFEA; }
table.m td.nm { width: 150px; font-size: 13px; }
table.m td.nm small { display: block; font: 11px ui-monospace, Menlo, monospace; color: #8a948f; }
.cell { border-radius: 10px; padding: 6px 8px; display: grid; gap: 4px; }
.row4 { display: flex; align-items: center; gap: 10px; border-radius: 8px; padding: 3px 6px; }
.row4.on { background: var(--tint); }
/* 放大看构造 */
.big { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.big figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 12px; color: #56615c; }
.grid96 { position: relative; width: 96px; height: 96px; border-radius: 8px;
  background-image: linear-gradient(to right, rgba(0,123,103,.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,123,103,.10) 1px, transparent 1px);
  background-size: 4px 4px; outline: 1px dashed rgba(0,123,103,.25); outline-offset: -1px; }
.grid96::after { content: ""; position: absolute; inset: 8px; border: 1px dashed rgba(201,59,48,.35); border-radius: 2px; }
/* 左栏小样 */
.rails { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.rail { background: var(--sidebar); color: var(--ink); border-radius: 14px; padding: 12px 10px; font-size: 13.5px; border: 1px solid var(--line); }
.rail .top { display: flex; align-items: center; gap: 8px; padding: 2px 6px 12px; font-weight: 600; }
.rail .lbl { font-size: 11px; color: var(--muted); padding: 10px 10px 4px 30px; }
.nav { display: flex; align-items: center; gap: 10px; border-radius: 10px; padding: 6px 10px; white-space: nowrap; }
.nav.on { background: var(--tint); color: var(--brand-ink); font-weight: 500; }
.nav.off { color: var(--ink); } .nav.off .ic { color: var(--muted); }
.nav .cnt { margin-left: auto; font-size: 11px; padding: 0 6px; border-radius: 4px; background: var(--line); color: var(--ink); font-variant-numeric: tabular-nums; }
.pos { display: flex; align-items: center; }
.chev { width: 20px; flex: none; display: flex; justify-content: center; color: var(--muted); }
.duties { margin: 0 0 2px 20px; padding-left: 8px; border-left: 1px solid var(--line); display: grid; gap: 2px; }
.duties .nav { font-size: 13px; }
.notes li { margin: 0 0 6px; }
@media (max-width: 900px) { .pair, .rails { grid-template-columns: 1fr; } .ov, .big { grid-template-columns: repeat(3, 1fr); } }
`

// ── 各节 ───────────────────────────────────────────────────────────────
const STYLES = [
  [
    'L',
    '风格一「线描」',
    '24 网格、1.75 线宽、圆角端点，和工作台现有线性图标一个体系；选中时点睛那一笔换品牌色。',
  ],
  [
    'B',
    '风格二「块面」',
    '圆角方块拼成的小图形，块与块之间留缝，和六块标记一脉相承；未选中是两级灰，选中时主体取品牌渐变的蓝青、点睛取领头那块的黄。',
  ],
]
const THEMES = [
  ['t-light', '浅色'],
  ['t-dark', '深色'],
]

function overview() {
  return STYLES.map(([st, title, desc]) => {
    const panels = THEMES.map(([th, label]) => {
      const figs = POSITIONS.map(
        (p) => `<figure>${icon(st, p.id, 32)}<figcaption>${p.name}</figcaption></figure>`,
      ).join('')
      return `<div class="panel ${th} on"><h3>${label}</h3><div class="ov">${figs}</div></div>`
    })
    return `<div class="card"><h3>${title}</h3><p class="lead">${desc}</p><div class="pair">${panels.join('')}</div></div>`
  }).join('')
}

function matrixCell(st, th, item) {
  const row = (state) =>
    `<div class="row4 ${state}">${SIZES.map((sz) => icon(st, item.base ?? item.id, sz, item.fav)).join('')}</div>`
  return `<td><div class="cell ${th}">${row('off')}${row('on')}</div></td>`
}

function matrix(items) {
  const head = STYLES.flatMap(([st]) =>
    THEMES.map(([, l]) => `<th>${st === 'L' ? '线描' : '块面'} · ${l}</th>`),
  )
  const rows = items.map(
    (it) =>
      `<tr><td class="nm">${it.name}<small>${it.sub}</small></td>${STYLES.flatMap(([st]) =>
        THEMES.map(([th]) => matrixCell(st, th, it)),
      ).join('')}</tr>`,
  )
  return `<div class="card"><table class="m"><thead><tr><th></th>${head.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>
<p class="lead" style="margin:8px 0 0">每格上一行未选中、下一行选中（左栏的选中底），从左到右 16 / 20 / 24 / 32 px。</p></div>`
}

function construction(items) {
  return STYLES.map(([st, title]) => {
    const figs = items
      .map((p) => `<figure><div class="grid96">${icon(st, p.id, 96)}</div>${p.name}</figure>`)
      .join('')
    return `<div class="card t-light on"><h3>${title}</h3><div class="big">${figs}</div></div>`
  }).join('')
}

// ── 左栏小样：照 app-shell.tsx 的结构（岗位行首展开箭头、展开层只列职责），职责行加上图标 ──
/** 左栏里别的行（首页 / 消息）的小图标与展开箭头：只是陪衬，也是手画的。 */
const GLYPH = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>',
  inbox: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  right: '<path d="m10 7 5 5-5 5"/>',
}
const glyph = (k, size) =>
  `<svg class="ic" width="${size}" height="${size}" ${LINE_ATTRS} aria-hidden="true">${GLYPH[k]}</svg>`

const RAIL = [
  { pos: 'owner' },
  {
    pos: 'customer-care',
    cnt: 3,
    duties: ['dtc.support', 'dtc.live-chat', 'amz.support', 'dtc.community-support'],
  },
  { pos: 'kol-marketing', cnt: 2, duties: ['kol.youtube', 'kol.instagram', 'kol.tiktok'] },
  { pos: 'social-media', cnt: 1 },
  { pos: 'ads' },
  { pos: 'b2b', duties: ['b2b.sales', 'b2b.outbound', 'b2b.exhibition', 'b2b.fulfillment'] },
  { pos: 'web-ops' },
  { pos: 'site' },
  { pos: 'design' },
  { pos: 'pr' },
]
const SELECTED = 'kol.youtube'

function dutyIcon(st, id) {
  const ch = CHANNELS.find((c) => c.id === id)
  if (ch) return icon(st, ch.base, 16, ch.fav)
  return icon(st, id, 16)
}

function rail(st, th, label) {
  const rows = RAIL.map((r) => {
    const p = POSITIONS.find((x) => x.id === r.pos)
    const open = r.duties !== undefined
    const cnt = r.cnt ? `<span class="cnt">${r.cnt}</span>` : ''
    const head = `<div class="pos"><span class="chev">${glyph(open ? 'down' : 'right', 14)}</span><div class="nav off" style="flex:1">${icon(st, r.pos, 16)}<span>${p.name}</span>${cnt}</div></div>`
    if (!open) return head
    const ds = r.duties
      .map(
        (d) =>
          `<div class="nav ${d === SELECTED ? 'on' : 'off'}">${dutyIcon(st, d)}<span>${dutyName(d)}</span></div>`,
      )
      .join('')
    return `${head}<div class="duties">${ds}</div>`
  }).join('')
  const stops = th === 't-light' ? STOPS_ON_LIGHT : STOPS_ON_DARK
  return `<div><div class="rail ${th}"><div class="top">${mark(24, stops, `mk-${st}-${th}`)}Agents 工坊</div>
<div class="nav off">${glyph('home', 16)}<span>首页</span></div><div class="nav off">${glyph('inbox', 16)}<span>消息</span></div>
<div class="lbl">岗位</div>${rows}</div><p class="lead" style="margin:6px 2px 0;font-size:12px">${label}</p></div>`
}

function rails() {
  const cells = STYLES.flatMap(([st, title]) =>
    THEMES.map(([th, l]) => rail(st, th, `${title} · ${l}`)),
  )
  return `<div class="rails">${cells.join('')}</div>`
}

// ── 页面 ───────────────────────────────────────────────────────────────
const NOTES = [
  '<b>我推荐风格一「线描」</b>：左栏里首页 / 消息 / 设置等还是线性图标，线描放进去是一家人；16px 下线描的轮廓比块面清楚（块面未选中是两团灰）；平台角标是彩色的，底下是单色线条时更好认。块面更像品牌、更有性格，适合 32px 以上的地方（公司页岗位卡、首次设置、官网）——如果想要两全，可以「列表用线描、大卡用块面」，代价是两套都要维护。',
  '<b>渠道类职责</b> = 所在岗位的图标 + 右下角平台角标。角标用 WP210 抓进仓库的官网 favicon，原样按比例放进方格，不改色、不裁；图标在角标后面让出一道缝（遮罩挖的，换什么底色都对）。',
  '<b>非渠道类职责</b>专门画一枚（本页 16 枚）。第二阶段补齐其余的。',
  '<b>Amazon 客服</b>：WP210 没有 Amazon 的 favicon（连接目录里没有 Amazon 这一家），先按 docs/36 §8 用首字母单色徽标顶着。',
  '<b>深色下的黑底角标</b>：X、Threads、TikTok 的官方图本身是黑底，放在深色左栏里偏暗。按商标规矩不改色，只能这样。',
  '<b>会撞的两处</b>：建站四条全是 Shopify、社媒的 Facebook 主页 / 群组同一张 Facebook 角标——同一岗位里一模一样。建议这两处不走「岗位图标 + 角标」，而是专门画一枚再挂角标。',
]

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>岗位与职责图标</title>
<!-- WP213 · 由 scripts/gen-position-icons-preview.mjs 生成，不手改。图标源在 docs/design/icons/src/。 -->
<style>${CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols.join('\n')}</defs></svg>
<main>
<h1>岗位与职责图标 · 两种画风</h1>
<p class="lead">给 12 个岗位（10 个模板 + 负责人 / 普通成员）和 16 条代表性职责各画了一枚，两种画风各一套。全部手画，没有用任何图标库。</p>

<h2 id="overview">总览</h2>
${overview()}

<h2 id="rail">左栏实景</h2>
<p class="lead">岗位树展开态，选中「红人营销 › YouTube 红人」。职责行现在没有图标，这里是加上之后的样子。</p>
${rails()}

<h2 id="positions">岗位 · 逐枚</h2>
${matrix(POSITIONS)}

<h2 id="duties">职责 · 非渠道类（专门画）</h2>
${matrix(DUTIES)}

<h2 id="channels">职责 · 渠道类（岗位图标 + 平台角标）</h2>
${matrix(CHANNELS)}

<h2 id="construction">放大看构造</h2>
<p class="lead">96px，底格一格 = 24 网格的 1 个单位，红虚线是四周 2 个单位的留白线。</p>
${construction(POSITIONS)}
${construction(DUTIES)}

<h2 id="notes">规则与待定</h2>
<div class="card"><ul class="notes">${NOTES.map((n) => `<li>${n}</li>`).join('')}</ul></div>
</main>
</body>
</html>
`

writeFileSync(OUT, html)
console.log(`写好了 ${OUT}（${(html.length / 1024).toFixed(0)} KB）`)
