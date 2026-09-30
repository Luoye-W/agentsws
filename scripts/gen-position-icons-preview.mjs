#!/usr/bin/env node
/**
 * WP213：出 `docs/design/icons/position-duty-icons.html`——岗位与职责图标的预览页
 * （单文件、内联 SVG、不引外部脚本 / 字体 / 图片，打开时不发任何请求）。
 *
 *     node scripts/gen-position-icons-preview.mjs
 *
 * 第一阶段（两种画风二选一）Luoye 09-30 选了「线描」；这一版只画线描，图形与对照表**直接读工作台
 * 那一份**（`apps/workstation/src/components/role-icons/{glyphs,duty-icons}.ts`，Node 直接读 .ts），
 * 所以预览页看到的就是产品里那一套。平台角标读 `apps/workstation/src/assets/brand`（WP210 入库的
 * 官网 favicon），以 data URI 内联，每张只存一份（`<symbol>` + `<use>`）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DUTY_ICONS,
  POSITION_GLYPH_BY_ID,
} from '../apps/workstation/src/components/role-icons/duty-icons.ts'
import { badgeGeometry, GLYPHS } from '../apps/workstation/src/components/role-icons/glyphs.ts'
import {
  ALL_BLOCKS,
  BLOCK_RADIUS,
  BLOCK_SIZE,
  GRADIENT_AXIS,
  STOPS_ON_DARK,
  STOPS_ON_LIGHT,
  VIEW_BOX,
} from '../packages/brand/src/geometry.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs/design/icons/position-duty-icons.html')
const BRAND_DIR = join(ROOT, 'apps/workstation/src/assets/brand')

// ── 名单与名字：从 packages/roles 当场读 ────────────────────────────────
const yml = (file) => readFileSync(join(ROOT, 'packages/roles', file), 'utf8')
const zhOf = (text) => /^name:\s*\{\s*zh:\s*([^,]+),/m.exec(text)?.[1]?.trim() ?? '?'
const dutyName = (id) => zhOf(yml(`roles/${id.replace('.', '/')}.yml`))

const ORDER = [
  'customer-care',
  'web-ops',
  'kol-marketing',
  'social-media',
  'ads',
  'site',
  'design',
  'pr',
  'b2b',
  'dtc-ops',
]
const POSITIONS = [
  { id: 'owner', name: '负责人', glyph: 'owner', roles: ['common.owner'] },
  ...ORDER.map((id) => {
    const text = yml(`positions/${id}.yml`)
    return {
      id,
      name: zhOf(text),
      glyph: /^icon:\s*(\S+)/m.exec(text)?.[1] ?? POSITION_GLYPH_BY_ID[id],
      roles: [...text.matchAll(/\{\s*role:\s*([\w.-]+)/g)].map((m) => m[1]),
    }
  }),
  { id: 'member', name: '普通成员', glyph: 'member', roles: ['common.member'] },
]

// ── 平台角标：官网 favicon，每张只内联一份 ───────────────────────────────
const MANIFEST = JSON.parse(readFileSync(join(BRAND_DIR, 'MANIFEST.json'), 'utf8'))
const favKey = (badge) => MANIFEST.aliases?.[badge] ?? badge
function favSymbol(key) {
  const entry = MANIFEST.icons[key]
  if (entry === undefined) throw new Error(`MANIFEST 里没有 ${key}`)
  const bytes = readFileSync(join(BRAND_DIR, entry.file))
  const mime = entry.format === 'svg' ? 'image/svg+xml' : 'image/png'
  return `<symbol id="fav-${key}" viewBox="0 0 1 1"><image href="data:${mime};base64,${bytes.toString('base64')}" width="1" height="1" preserveAspectRatio="xMidYMid meet"/></symbol>`
}

// ── 图形 → SVG 串（与 role-icon.tsx 的 el() 同一条规则）───────────────────
const ACC = [
  '',
  ' style="stroke:var(--ia,currentColor)"',
  ' style="stroke:var(--ia,currentColor);fill:var(--ia,currentColor)"',
]
function el(e) {
  if (e[0] === 'path') return `<path d="${e[1]}"${ACC[e[2] ?? 0]}/>`
  if (e[0] === 'circle') return `<circle cx="${e[1]}" cy="${e[2]}" r="${e[3]}"${ACC[e[4] ?? 0]}/>`
  return `<rect x="${e[1]}" y="${e[2]}" width="${e[3]}" height="${e[4]}" rx="${e[5]}"${ACC[e[6] ?? 0]}/>`
}
const LINE_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'
const symbols = Object.entries(GLYPHS).map(
  ([id, g]) => `<symbol id="L-${id}" ${LINE_ATTRS}>${g.map(el).join('')}</symbol>`,
)
const badgeKeys = Object.values(DUTY_ICONS).flatMap((s) => (s.badge ? [favKey(s.badge)] : []))
for (const key of new Set(badgeKeys)) symbols.push(favSymbol(key))

const SIZES = [16, 20, 24, 32]
for (const size of [...SIZES, 96]) {
  const b = badgeGeometry(size)
  symbols.push(
    `<mask id="cut-${size}" maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32"><rect x="-4" y="-4" width="32" height="32" fill="#fff"/><circle cx="${b.cx}" cy="${b.cx}" r="${b.cut}" fill="#000"/></mask>`,
  )
}

/** 一枚图标：图形 + 可选角标（浅色圆底 + 官网图），与 `<RoleGlyph>` 同一套几何。 */
function icon(glyph, size, badge) {
  const open = `<svg class="ic" width="${size}" height="${size}" ${LINE_ATTRS} overflow="visible" aria-hidden="true">`
  if (!badge) return `${open}<use href="#L-${glyph}" width="24" height="24"/></svg>`
  const b = badgeGeometry(size)
  const ring = (0.75 * 24) / size
  const at = b.cx - b.img / 2
  return (
    `${open}<g mask="url(#cut-${size})"><use href="#L-${glyph}" width="24" height="24"/></g>` +
    `<circle cx="${b.cx}" cy="${b.cx}" r="${b.r}" stroke="none" style="fill:var(--ws-badge-plate)"/>` +
    `<circle cx="${b.cx}" cy="${b.cx}" r="${b.r}" fill="none" stroke-width="${ring}" style="stroke:var(--ws-badge-ring)"/>` +
    `<use href="#fav-${favKey(badge)}" x="${at}" y="${at}" width="${b.img}" height="${b.img}"/></svg>`
  )
}
const dutyIcon = (id, size) => {
  const spec = DUTY_ICONS[id] ?? { glyph: 'generic' }
  return icon(spec.glyph, size, spec.badge)
}

/** 品牌标记（左栏小样顶上那枚）：照 @agentsws/brand 的几何与渐变拼。 */
function mark(size, stops, id) {
  const g = GRADIENT_AXIS
  const st = stops.map((s) => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('')
  const rects = ALL_BLOCKS.map(
    (b) =>
      `<rect x="${b.x}" y="${b.y}" width="${BLOCK_SIZE}" height="${BLOCK_SIZE}" rx="${BLOCK_RADIUS}" fill="url(#${id})"/>`,
  ).join('')
  return `<svg width="${size}" height="${size}" viewBox="${VIEW_BOX}" aria-hidden="true"><defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${st}</linearGradient></defs>${rects}</svg>`
}

// ── 各节 ───────────────────────────────────────────────────────────────
const THEMES = [
  ['t-light', '浅色'],
  ['t-dark', '深色'],
]

function overview() {
  const panels = THEMES.map(([th, label]) => {
    const figs = POSITIONS.map(
      (p) => `<figure>${icon(p.glyph, 32)}<figcaption>${p.name}</figcaption></figure>`,
    ).join('')
    return `<div class="panel ${th} on"><h3>${label}</h3><div class="ov">${figs}</div></div>`
  })
  return `<div class="card"><div class="pair">${panels.join('')}</div></div>`
}

/** 逐枚表：每行一枚，明暗两格，每格未选中 / 选中两行 × 四个尺寸。`groups` = [[组名, 行…]…]。 */
function matrix(groups) {
  const cell = (th, draw) => {
    const row = (state) => `<div class="row4 ${state}">${SIZES.map(draw).join('')}</div>`
    return `<td><div class="cell ${th}">${row('off')}${row('on')}</div></td>`
  }
  const body = groups
    .map(([label, items]) => {
      const head = label === '' ? '' : `<tr class="grp"><td colspan="3">${label}</td></tr>`
      const rows = items.map(
        (it) =>
          `<tr><td class="nm">${it.name}<small>${it.sub}</small></td>${THEMES.map(([th]) => cell(th, it.draw)).join('')}</tr>`,
      )
      return head + rows.join('')
    })
    .join('')
  return `<div class="card"><table class="m"><thead><tr><th></th><th>浅色</th><th>深色</th></tr></thead><tbody>${body}</tbody></table>
<p class="lead" style="margin:8px 0 0">每格上一行未选中、下一行选中（左栏的选中底），从左到右 16 / 20 / 24 / 32 px。</p></div>`
}

const positionRows = POSITIONS.map((p) => ({
  name: p.name,
  sub:
    p.id === 'owner' || p.id === 'member'
      ? `${p.id}（org.ts 种的）`
      : `${p.id}.yml · icon: ${p.glyph}`,
  draw: (sz) => icon(p.glyph, sz),
}))
/** 职责按岗位分组；负责人 / 普通成员那两条底座职责归到最后一组。 */
const dutyGroups = POSITIONS.filter(
  (p) => p.id !== 'owner' && p.id !== 'member' && p.id !== 'dtc-ops',
)
  .map((p) => [
    p.name,
    p.roles.map((id) => ({
      name: dutyName(id),
      sub: `${id}${DUTY_ICONS[id]?.badge ? ` · ${DUTY_ICONS[id].badge}` : ''}`,
      draw: (sz) => dutyIcon(id, sz),
    })),
  ])
  .concat([
    [
      '工作区底座 / 老职责',
      ['common.owner', 'common.member', 'social.meta'].map((id) => ({
        name: dutyName(id),
        sub: id,
        draw: (sz) => dutyIcon(id, sz),
      })),
    ],
  ])

function construction() {
  const all = [
    ...POSITIONS.map((p) => ({ name: p.name, html: icon(p.glyph, 96) })),
    ...Object.entries(DUTY_ICONS).map(([id, s]) => ({
      name: dutyName(id),
      html: icon(s.glyph, 96, s.badge),
    })),
  ]
  const figs = all
    .map((f) => `<figure><div class="grid96">${f.html}</div>${f.name}</figure>`)
    .join('')
  return `<div class="card t-light on"><div class="big">${figs}</div></div>`
}

// ── 左栏小样：照 app-shell.tsx 的结构（行首展开箭头、展开层只列职责、职责行带图标）──────
/** 左栏里别的行（首页 / 消息）的小图标与展开箭头：只是陪衬，也是手画的。 */
const SIDE = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/>',
  inbox: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  right: '<path d="m10 7 5 5-5 5"/>',
}
const side = (k, size) =>
  `<svg class="ic" width="${size}" height="${size}" ${LINE_ATTRS} aria-hidden="true">${SIDE[k]}</svg>`
const OPEN = {
  'customer-care': 3,
  'kol-marketing': 2,
  'social-media': 1,
  ads: 0,
  site: 0,
}
const SHOWN = {
  'social-media': [
    'social.facebook',
    'social.facebook-group',
    'social.instagram',
    'social.tiktok',
    'social.discord',
  ],
}
const SELECTED = 'kol.youtube'

function rail(th, label) {
  const rows = POSITIONS.filter((p) => p.id !== 'dtc-ops' && p.id !== 'member')
    .map((p) => {
      const open = p.id in OPEN
      const cnt = OPEN[p.id] ? `<span class="cnt">${OPEN[p.id]}</span>` : ''
      const head = `<div class="pos"><span class="chev">${side(open ? 'down' : 'right', 14)}</span><div class="nav off" style="flex:1">${icon(p.glyph, 16)}<span>${p.name}</span>${cnt}</div></div>`
      if (!open) return head
      const ds = (SHOWN[p.id] ?? p.roles)
        .map(
          (d) =>
            `<div class="nav ${d === SELECTED ? 'on' : 'off'}">${dutyIcon(d, 16)}<span>${dutyName(d)}</span></div>`,
        )
        .join('')
      return `${head}<div class="duties">${ds}</div>`
    })
    .join('')
  const stops = th === 't-light' ? STOPS_ON_LIGHT : STOPS_ON_DARK
  return `<div><div class="rail ${th}"><div class="top">${mark(24, stops, `mk-${th}`)}Agents 工坊</div>
<div class="nav off">${side('home', 16)}<span>首页</span></div><div class="nav off">${side('inbox', 16)}<span>消息</span></div>
<div class="lbl">岗位</div>${rows}</div><p class="lead" style="margin:6px 2px 0;font-size:12px">${label}</p></div>`
}

// ── 页面 ───────────────────────────────────────────────────────────────
const NOTES = [
  '<b>线描</b>（Luoye 09-30 选定）：24 网格、1.75 线宽、圆角端点；每枚一笔点睛，<b>选中时点睛换品牌绿</b>，其余跟文字同色。',
  '<b>渠道类职责</b> = 所在岗位的图标 + 右下角平台角标。角标是官网 favicon，<b>下面垫一块浅色圆底</b>（深色主题下也是浅的，X / Threads / TikTok 这种黑底的官方图才看得见），官方图本身不改色、不裁；图标在角标后面让出一道缝。',
  '<b>同一个岗位里没有两枚一样的</b>：建站四条（全是 Shopify）、Facebook 主页 / 群组各画一枚专门的，再挂角标。',
  '<b>非渠道类职责</b>专门画一枚；岗位 yml 只加一个 <code>icon</code> 字段，职责走对照表（<code>role-icons/duty-icons.ts</code>）。用户自建的岗位按它的第一条职责推一枚。',
]

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
  --ws-badge-plate:#FFFFFF; --ws-badge-ring:rgba(38,51,49,.14); }
.t-dark { --paper:#0E100F; --card:#171A18; --line:#242825; --ink:#F1F4F0; --muted:#98A29B; --brand:#76FB91; --brand-ink:#B9FFC9; --tint:#173C24; --sidebar:#121513;
  --ws-badge-plate:#F1F4F0; --ws-badge-ring:transparent; }
.t-light, .t-dark { background: var(--card); color: var(--ink); }
.off { color: var(--muted); --ia: currentColor; }
.on { color: var(--brand-ink); --ia: var(--brand); }
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
.big { display: grid; grid-template-columns: repeat(8, 1fr); gap: 12px; }
.big figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 12px; color: #56615c; }
.grid96 { position: relative; width: 96px; height: 96px; border-radius: 8px;
  background-image: linear-gradient(to right, rgba(0,123,103,.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,123,103,.10) 1px, transparent 1px);
  background-size: 4px 4px; outline: 1px dashed rgba(0,123,103,.25); outline-offset: -1px; }
.grid96::after { content: ""; position: absolute; inset: 8px; border: 1px dashed rgba(201,59,48,.35); border-radius: 2px; }
/* 左栏小样 */
.rails { display: grid; grid-template-columns: repeat(2, 300px); gap: 16px; }
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
tr.grp td { padding: 14px 8px 4px; font-weight: 600; font-size: 13px; border-top: none; }
@media (max-width: 900px) { .pair, .rails { grid-template-columns: 1fr; } .ov, .big { grid-template-columns: repeat(3, 1fr); } }
`

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>岗位与职责图标</title>
<!-- WP213 · 由 scripts/gen-position-icons-preview.mjs 生成，不手改。图形源在 apps/workstation/src/components/role-icons/。 -->
<style>${CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols.join('\n')}</defs></svg>
<main>
<h1>岗位与职责图标 · 线描</h1>
<p class="lead">12 个岗位、${Object.keys(DUTY_ICONS).length} 条职责，全部手画。页面里的图形就是工作台用的那一份。</p>

<h2 id="overview">岗位总览</h2>
${overview()}

<h2 id="rail">左栏实景</h2>
<p class="lead">岗位树展开态，选中「红人营销 › YouTube 红人」。</p>
<div class="rails">${THEMES.map(([th, l]) => rail(th, l)).join('')}</div>

<h2 id="positions">岗位 · 逐枚</h2>
${matrix([['', positionRows]])}

<h2 id="duties">职责 · 全部</h2>
${matrix(dutyGroups)}

<h2 id="construction">放大看构造</h2>
<p class="lead">96px，底格一格 = 24 网格的 1 个单位，红虚线是四周 2 个单位的留白线。</p>
${construction()}

<h2 id="notes">规则</h2>
<div class="card"><ul class="notes">${NOTES.map((n) => `<li>${n}</li>`).join('')}</ul></div>
</main>
</body>
</html>
`

writeFileSync(OUT, html)
console.log(`写好了 ${OUT}（${(html.length / 1024).toFixed(0)} KB）`)
