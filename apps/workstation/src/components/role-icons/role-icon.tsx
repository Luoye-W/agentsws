/**
 * WP213：岗位与职责的统一图标（docs/36 §8.3，Luoye 09-30 选「线描」）。
 *
 * - `<PositionIcon>`：岗位。优先用接口给的 `icon`（内置模板 yml 里写的），没有就按模板 id 认
 *   （负责人 / 普通成员），再没有（用户自建的岗位）按它的第一条职责推，推不出来落 `generic`。
 * - `<DutyIcon>`：职责。按 `duty-icons.ts` 的对照表：渠道类 = 岗位图标 + 右下角平台角标，
 *   非渠道类 = 专门画的一枚。认不出的职责落 `generic`。
 *
 * 选中态：点睛那一笔画成 `var(--ia, currentColor)`——平时跟着文字灰，外层（左栏选中行、⌘K 高亮项）
 * 设 `--ia: var(--ws-brand)` 就变品牌色；也可以直接传 `selected`。
 *
 * 角标：官网 favicon（`assets/brand/`，构建期打进产物，**运行时不联网**）放在一块浅色圆底上
 * （`--ws-badge-plate`，深色主题下也是浅的——X / Threads / TikTok 的黑底官方图才看得见），
 * 官方图本身原样、按比例放进方格（docs/36 §8 商标三条）；岗位图标在角标后面用遮罩让出一道缝。
 * 图标一律 `aria-hidden`：旁边永远有一行字。
 */
import { type ReactNode, useId } from 'react'
import { officialIconUrl } from '@/components/brand-icons'
import { cn } from '@/lib/utils'
import { DUTY_ICONS, type DutyIconSpec, POSITION_GLYPH_BY_ID } from './duty-icons'
import { badgeGeometry, GLYPHS, type GlyphEl } from './glyphs'

const ACCENT_STROKE = { stroke: 'var(--ia, currentColor)' } as const
const ACCENT_FILL = { stroke: 'var(--ia, currentColor)', fill: 'var(--ia, currentColor)' } as const

function el(e: GlyphEl, key: number): ReactNode {
  const accent = e[0] === 'path' ? e[2] : e[0] === 'circle' ? e[4] : e[6]
  const style = accent === 1 ? ACCENT_STROKE : accent === 2 ? ACCENT_FILL : undefined
  if (e[0] === 'path') return <path key={key} d={e[1]} style={style} />
  if (e[0] === 'circle') return <circle key={key} cx={e[1]} cy={e[2]} r={e[3]} style={style} />
  return <rect key={key} x={e[1]} y={e[2]} width={e[3]} height={e[4]} rx={e[5]} style={style} />
}

/** 一枚图标：图形 + 可选角标。 */
export function RoleGlyph({
  glyph,
  badge,
  size = 16,
  selected = false,
  className,
  testId = 'role-icon',
}: {
  glyph: string
  badge?: string
  size?: number
  selected?: boolean
  className?: string
  testId?: string
}): ReactNode {
  const maskId = `ri-${useId().replace(/:/g, '')}`
  const id = GLYPHS[glyph] === undefined ? 'generic' : glyph
  const parts = (GLYPHS[id] ?? []).map(el)
  const url = badge === undefined ? undefined : officialIconUrl(badge)
  const b = badgeGeometry(size)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      overflow="visible"
      aria-hidden
      data-testid={testId}
      data-glyph={id}
      {...(badge === undefined ? {} : { 'data-badge': badge })}
      className={cn('shrink-0', className)}
      style={selected ? ({ '--ia': 'var(--ws-brand)' } as React.CSSProperties) : undefined}
    >
      {url === undefined ? (
        parts
      ) : (
        <>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32">
            <rect x="-4" y="-4" width="32" height="32" fill="#fff" stroke="none" />
            <circle cx={b.cx} cy={b.cx} r={b.cut} fill="#000" stroke="none" />
          </mask>
          <g mask={`url(#${maskId})`}>{parts}</g>
          <circle
            cx={b.cx}
            cy={b.cx}
            r={b.r}
            stroke="none"
            style={{ fill: 'var(--ws-badge-plate, #fff)' }}
          />
          <circle
            cx={b.cx}
            cy={b.cx}
            r={b.r}
            fill="none"
            strokeWidth={0.75 * (24 / size)}
            style={{ stroke: 'var(--ws-badge-ring, transparent)' }}
          />
          <image
            href={url}
            x={b.cx - b.img / 2}
            y={b.cx - b.img / 2}
            width={b.img}
            height={b.img}
            preserveAspectRatio="xMidYMid meet"
            data-testid="role-icon-badge"
          />
        </>
      )}
    </svg>
  )
}

/** 这条职责用哪一枚（对照表里没有的落 `generic`，不挂角标）。 */
export function dutyIconSpec(role_id: string): DutyIconSpec {
  return DUTY_ICONS[role_id] ?? { glyph: 'generic' }
}

/** 岗位用哪一枚图形：接口给的 → 模板 id → 第一条认得出的职责 → `generic`。 */
export function positionGlyph(
  position_id: string,
  icon?: string,
  role_ids: readonly string[] = [],
): string {
  if (icon !== undefined && GLYPHS[icon] !== undefined) return icon
  const byId = POSITION_GLYPH_BY_ID[position_id]
  if (byId !== undefined) return byId
  for (const r of role_ids) {
    const spec = DUTY_ICONS[r]
    if (spec !== undefined) return spec.glyph
  }
  return 'generic'
}

export function PositionIcon({
  position_id,
  icon,
  role_ids,
  size = 16,
  selected,
  className,
}: {
  position_id: string
  icon?: string | undefined
  /** 用户自建的岗位没有图标：按它的职责推一枚。 */
  role_ids?: readonly string[]
  size?: number
  selected?: boolean
  className?: string
}): ReactNode {
  return (
    <RoleGlyph
      glyph={positionGlyph(position_id, icon, role_ids)}
      size={size}
      testId="position-icon"
      {...(selected === undefined ? {} : { selected })}
      {...(className === undefined ? {} : { className })}
    />
  )
}

export function DutyIcon({
  role_id,
  size = 16,
  selected,
  className,
}: {
  role_id: string
  size?: number
  selected?: boolean
  className?: string
}): ReactNode {
  const spec = dutyIconSpec(role_id)
  return (
    <RoleGlyph
      glyph={spec.glyph}
      size={size}
      testId="duty-icon"
      {...(spec.badge === undefined ? {} : { badge: spec.badge })}
      {...(selected === undefined ? {} : { selected })}
      {...(className === undefined ? {} : { className })}
    />
  )
}
