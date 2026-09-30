/**
 * WP213 风格二「块面」：岗位与职责图标的草稿（第一阶段，只进预览页）。
 *
 * 规矩：借品牌六块标记的几何语言——圆角方块、块与块之间留缝（≈ 1.5 个网格单位，
 * 与标记里 17 : 7 的块缝比同一个意思）、实心、双色。
 *   - `--c1` 主体、`--c2` 点睛（相当于标记里领头那一块）；两种颜色由外层按明暗 / 选中态给。
 *   - 镂空一律走 `fill-rule="evenodd"` 或遮罩，**不靠底色盖**——放到任何底上都对。
 * 全部手画，不描任何图标库。负责人那一枚的方块位置直接从 `@agentsws/brand` 的几何算。
 */
import { BLOCK_RADIUS, BLOCK_SIZE, BLOCKS } from '../../../../packages/brand/src/geometry.ts'

const n = (v) => Number(v.toFixed(3))

/** 圆角矩形（子路径）。`r` 可以是一个数，也可以是 [左上, 右上, 右下, 左下]。 */
export function rr(x, y, w, h, r) {
  const [a, b, c, d] = Array.isArray(r) ? r : [r, r, r, r]
  return (
    `M${n(x + a)} ${n(y)}H${n(x + w - b)}a${b} ${b} 0 0 1 ${b} ${b}V${n(y + h - c)}` +
    `a${c} ${c} 0 0 1 -${c} ${c}H${n(x + d)}a${d} ${d} 0 0 1 -${d} -${d}V${n(y + a)}` +
    `a${a} ${a} 0 0 1 ${a} -${a}z`
  )
}

/** 圆（子路径）。 */
export function circ(cx, cy, r) {
  return `M${n(cx - r)} ${n(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0z`
}

/** 一块颜色：`tone` 1 = 主体，2 = 点睛。可带遮罩。 */
function P(tone, d, mask) {
  const m = mask ? ` mask="url(#${mask})"` : ''
  return `<path fill-rule="evenodd" style="fill:var(--c${tone})"${m} d="${d}"/>`
}

/** 一笔粗线（箭杆、钥匙杆这种），颜色同块面。 */
function S(tone, d, w = 2.4) {
  return `<path d="${d}" fill="none" style="stroke:var(--c${tone});stroke-width:${w};stroke-linecap:round;stroke-linejoin:round"/>`
}

/** 遮罩：白底，`cut` 里的形状挖掉（黑）。`cut` 是完整的元素串。 */
function M(id, cut) {
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28"><rect x="-2" y="-2" width="28" height="28" fill="#fff"/>${cut}</mask>`
}
const K = (d) => `<path d="${d}" fill="#000"/>`
const KS = (d, w) =>
  `<path d="${d}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`

/** 雨棚：三块下沿圆得多的方块（店铺那两枚共用）。 */
const AWNING = [2.5, 9.2, 15.9].map((x) => P(2, rr(x, 3, 5.6, 5.5, [1, 1, 2.8, 2.8]))).join('')

/**
 * 负责人：标记最左边两列那三块（b1、b2、b3）——一变一队的「种子」。按真几何等比缩进 24 网格，
 * 最上面那块（b3）用点睛色当领头。线描那一枚用同一组坐标（`OWNER_BLOCKS`）。
 */
export const OWNER_BLOCKS = (() => {
  const pick = [BLOCKS[0], BLOCKS[1], BLOCKS[2]]
  const minX = Math.min(...pick.map((b) => b.x))
  const minY = Math.min(...pick.map((b) => b.y))
  const span = Math.max(...pick.map((b) => b.x)) - minX + BLOCK_SIZE
  const s = 20 / span
  return {
    size: BLOCK_SIZE * s,
    r: Math.max(BLOCK_RADIUS * s, 1),
    at: pick.map((b) => [2 + (b.x - minX) * s, 2 + (b.y - minY) * s]),
  }
})()
function ownerBlocks() {
  const { size, r, at } = OWNER_BLOCKS
  return [P(1, rr(...at[0], size, size, r) + rr(...at[1], size, size, r)), P(2, rr(...at[2], size, size, r))]
}

export const BLOCK_POSITIONS = {
  // 客服：三块拼成耳机，罩着一个带「像素尾巴」的对话框
  'customer-care': [
    P(2, rr(5, 2.5, 14, 2.5, 1.25) + rr(2, 6.5, 3, 8, 1.25) + rr(19, 6.5, 3, 8, 1.25)),
    P(1, rr(6.5, 7, 11, 8.5, 2) + [8.6, 11.1, 13.6].map((x) => rr(x, 10.35, 1.8, 1.8, 0.5)).join('')),
    P(1, rr(8, 17, 3, 3, 0.8)),
  ],
  // 红人营销：方头方身的人 + 两颗菱形星
  'kol-marketing': [
    P(1, rr(4.5, 3, 7.5, 7.5, 2.4) + rr(2, 12, 11.5, 9.5, [4, 4, 1.5, 1.5])),
    `<g style="fill:var(--c2)"><rect x="15.75" y="3.25" width="5.5" height="5.5" rx="1.2" transform="rotate(45 18.5 6)"/><rect x="17.7" y="13.7" width="2.6" height="2.6" rx=".6" transform="rotate(45 19 15)"/></g>`,
  ],
  // B2B：码起来的三只集装箱，顶上那只是点睛色
  b2b: [
    P(1, [1.5, 12.5].map((x) => rr(x, 13, 10, 7.5, 1.2) + [3, 5.25, 7.5].map((o) => rr(x + o - 0.5, 15, 1, 3.5, 0.5)).join('')).join('')),
    P(2, rr(7, 4, 10, 7.5, 1.2) + [3, 5.25, 7.5].map((o) => rr(7 + o - 0.5, 6, 1, 3.5, 0.5)).join('')),
  ],
  // 投放：方靶 + 冲出去的箭头，箭头穿过的地方靶环让开
  ads: [
    M('bk-ads', KS('M10.5 13.5 19 5', 5.4) + K('M23.5 0.5v10.2l-10.2-10.2z')),
    P(1, rr(2, 5, 17, 17, 4) + rr(5, 8, 11, 11, 2.2), 'bk-ads'),
    P(2, rr(8, 11, 5, 5, 1.3) + 'M21.5 2.5v7l-7-7z'),
    S(2, 'M10.5 13.5 17.5 6.5'),
  ],
  // 建站：顶栏 + 三块版面（一块主视觉点睛）
  site: [
    P(1, rr(2, 3, 20, 4, 1.5) + rr(13, 8.5, 9, 5.5, 1.5) + rr(13, 15.5, 9, 5.5, 1.5)),
    P(2, rr(2, 8.5, 9.5, 12.5, 1.5)),
  ],
  // 设计：三节的方块画笔，笔尖点在色块角上
  design: [
    P(2, rr(2, 15, 6.5, 6.5, 1.5)),
    `<g transform="rotate(45 15.5 8.5)">${P(1, rr(14.25, 0, 2.5, 5.5, 1.25) + rr(13.25, 6.5, 4.5, 3, 0.6))}${P(1, 'M13.5 10.5h4v2.5c0 2.2-.9 3.8-2 5-1.1-1.2-2-2.8-2-5z')}</g>`,
  ],
  // 公共关系：方块扩音器 + 三颗声音像素
  pr: [
    P(1, rr(2, 9, 4, 6, 1.2) + rr(8.25, 17, 2.5, 4, 1)),
    P(1, 'M7.5 9.2 15.2 5c.6-.3 1.3.1 1.3.8v12.4c0 .7-.7 1.1-1.3.8L7.5 14.8z'),
    P(2, [6, 10.75, 15.5].map((y) => rr(18.5, y, 3.5, 2.5, 1.1)).join('')),
  ],
  // 社媒运营：两只对话框，前面那只点睛色，后面那只给它让出一道缝
  'social-media': [
    M('bk-social', K(rr(8, 8, 15.5, 12, 3.5))),
    P(1, rr(2, 2.5, 12, 9, 2.5), 'bk-social'),
    P(1, rr(3.5, 13, 2.5, 2.5, 0.8)),
    P(2, rr(9.5, 9.5, 12.5, 9, 2.5) + rr(17, 19.75, 2.5, 2.5, 0.8)),
  ],
  // 独立站运营（老岗位）：雨棚 + 店身上一只仪表
  'dtc-ops': [
    AWNING,
    P(1, rr(4, 10, 16, 11.5, 1.5) + 'M8 18.5a4 4 0 0 1 8 0z'),
    S(2, 'M12 18.25 14.25 15.5', 1.6),
  ],
  // 网站运营：挖出经线与赤道的地球 + 三根往上长的柱
  'web-ops': [
    M('bk-globe', KS('M10 6a3.4 8 0 0 1 0 16a3.4 8 0 0 1 0-16zM2 14h16', 1.4)),
    P(1, circ(10, 14, 8), 'bk-globe'),
    P(2, rr(14.5, 4.5, 2, 2.5, 0.6) + rr(17, 3, 2, 4, 0.6) + rr(19.5, 1.5, 2, 5.5, 0.6)),
  ],
  owner: ownerBlocks(),
  // 普通成员：方头（点睛）+ 方身
  member: [P(2, rr(8.25, 2.5, 7.5, 7.5, 2.4)), P(1, rr(4, 11.5, 16, 10, [4.5, 4.5, 1.5, 1.5]))],
}

/** 信封的封口 V（镂空用）：1.9 宽的一道折线。 */
const flap = (x, y, w) => {
  const m = x + w / 2
  const d = w * 0.36
  return `M${x + 2} ${y + 2.5}L${m} ${y + 2.5 + d}L${x + w - 2} ${y + 2.5}v1.9L${m} ${y + 4.4 + d}L${x + 2} ${y + 4.4}z`
}

/** 钥匙齿：从杆的中线往垂直方向伸出去一截（留一道缝）。 */
function tooth(px, py) {
  const u = Math.SQRT1_2
  return `M${n(px + 2.4 * u)} ${n(py + 2.4 * u)}L${n(px + 4.2 * u)} ${n(py + 4.2 * u)}`
}

export const BLOCK_DUTIES = {
  'dtc.support': [
    P(1, rr(2, 3, 16, 11, 2) + flap(2, 3, 16)),
    P(2, 'M14 18.25 17.25 15v2h1.25a3.5 3.5 0 0 1 3.5 3.5V22h-2.2v-1.3a1.4 1.4 0 0 0-1.4-1.4h-1.15v2.2z'),
  ],
  'dtc.live-chat': [
    P(1, rr(2, 5, 15, 11, 2.5) + [5.7, 8.6, 11.5].map((x) => rr(x, 9.6, 1.8, 1.8, 0.5)).join('')),
    P(1, rr(4.5, 17.5, 3, 3, 0.8)),
    P(2, circ(20, 4, 2)),
  ],
  'dtc.community-support': [
    P(2, rr(9.5, 3, 5, 5, 1.6) + rr(7.5, 9.5, 9, 10, [3.5, 3.5, 1.2, 1.2])),
    P(1, rr(2.5, 6, 4, 4, 1.3) + rr(17.5, 6, 4, 4, 1.3) + rr(1.5, 11.5, 4.5, 8, [2.2, 2.2, 1, 1]) + rr(18, 11.5, 4.5, 8, [2.2, 2.2, 1, 1])),
  ],
  'dtc.store': [
    M('bk-store', K(rr(9.5, 15, 5, 8, 1))),
    AWNING,
    P(1, rr(4, 10, 16, 11.5, 1.5), 'bk-store'),
  ],
  'dtc.content': [
    M('bk-content', K(circ(16.5, 16.5, 5.6))),
    P(1, rr(3, 2.5, 13, 18, 2) + rr(6, 6.5, 7, 1.6, 0.8) + rr(6, 10, 7, 1.6, 0.8) + rr(6, 13.5, 3.5, 1.6, 0.8), 'bk-content'),
    P(2, circ(16.5, 16.5, 4) + circ(16.5, 16.5, 2.2)),
    S(2, 'M19.6 19.6 21.5 21.5', 2.4),
  ],
  'dtc.email-marketing': [
    P(1, rr(7, 5, 15, 12, 2) + flap(7, 5, 15)),
    P(2, rr(2.5, 7.5, 3, 1.9, 0.95) + rr(1, 10.55, 4.5, 1.9, 0.95) + rr(2.5, 13.6, 3, 1.9, 0.95)),
  ],
  'dtc.fulfillment': [
    P(1, rr(1.5, 4.5, 12.5, 11, 1.5) + circ(6, 18.5, 2.3) + circ(17.5, 18.5, 2.3)),
    P(2, 'M15.5 8h3.1c.4 0 .8.2 1.1.5l2.3 2.8c.2.3.3.6.3.9v3.3h-6.8z'),
  ],
  'b2b.sales': [
    M('bk-sales', K(rr(8, 10.5, 8, 4.5, 1.2))),
    P(1, rr(2, 12.5, 20, 8.5, 2), 'bk-sales'),
    P(2, 'M10.5 2.5h3v5.5h2.8L12 12.3 7.7 8h2.8z'),
  ],
  'b2b.outbound': [P(1, 'M21.5 2.5 2 10.2l6.9 2.9z'), P(2, 'M21.5 2.5 10.2 14.1l3.2 7.4z')],
  'b2b.exhibition': [
    P(2, rr(2, 2.5, 20, 5, 1.5)),
    P(1, rr(3, 9, 2.5, 12.5, 1) + rr(18.5, 9, 2.5, 12.5, 1) + rr(7.5, 13.5, 9, 8, 1.5)),
  ],
  'b2b.fulfillment': [
    M('bk-docs', K(circ(16.5, 16.5, 6))),
    M('bk-stamp', KS('m14.3 16.6 1.6 1.6 2.9-3.1', 1.5)),
    P(1, 'M6.5 2.5h7l5.5 5.5v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4a1.5 1.5 0 0 1 1.5-1.5z' + rr(7.5, 6, 4, 1.6, 0.8) + rr(7.5, 9.5, 6, 1.6, 0.8), 'bk-docs'),
    P(2, circ(16.5, 16.5, 4.5), 'bk-stamp'),
  ],
  'pr.press': [
    M('bk-press', K(rr(3.3, 4.8, 12.9, 5.9, 1.4))),
    P(1, rr(2, 3.5, 15.5, 17, 2) + rr(4.5, 13, 10.5, 1.6, 0.8) + rr(4.5, 16.5, 7, 1.6, 0.8), 'bk-press'),
    P(2, rr(4.5, 6, 10.5, 3.5, 0.8) + rr(19, 8, 3, 12.5, 1.5)),
  ],
  'pr.forums': [
    P(1, rr(2, 2.5, 16, 7, 1.8) + rr(4, 11, 2, 6.5, 1)),
    P(2, rr(7.5, 12, 14.5, 7, 1.8)),
  ],
  'pr.monitoring': [
    P(1, 'M1.5 12C4.2 7.3 7.8 5 12 5s7.8 2.3 10.5 7c-2.7 4.7-6.3 7-10.5 7S4.2 16.7 1.5 12z' + circ(12, 12, 4.4)),
    P(2, circ(12, 12, 2.6)),
  ],
  'common.owner': [
    P(1, rr(2, 12, 9.5, 9.5, 3.2) + rr(5.25, 15.25, 3, 3, 1)),
    S(1, 'M10.4 13.1 20.5 3', 2.6),
    S(2, tooth(15, 8.5) + tooth(18, 5.5), 2.2),
  ],
  'common.member': [
    P(1, rr(2.5, 7.5, 19, 13.5, 2) + rr(5.5, 10.5, 5, 6, 1.4) + rr(12.5, 11.5, 6, 1.6, 0.8) + rr(12.5, 15, 4.5, 1.6, 0.8)),
    P(2, rr(9.5, 3, 5, 3, 1)),
  ],
}
