/**
 * WP213（docs/36 §8.3）：岗位与职责图标。
 *
 * 名单一律**当场读仓库**，不抄在这里：
 * 1. 每条职责（`packages/roles/roles/**.yml`）都在对照表里，指向的图形真的有；
 * 2. 每个岗位（`packages/roles/positions/*.yml` 的 `icon` + 负责人 / 普通成员）都有图形；
 * 3. 角标都能在官网图库（`assets/brand/MANIFEST.json`）里找到，渲染出来的图是本地的，不是外站地址；
 * 4. **同一个岗位里没有两枚一样的**（建站四条、FB 主页 / 群组各画一枚再挂角标）；
 * 5. 负责人那一枚的三块与 `@agentsws/brand` 的真几何对得上；
 * 6. 选中态：点睛那一笔画成 `var(--ia, …)`，`selected` 时设成品牌色。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_SIZE, BLOCKS } from '@agentsws/brand'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasOfficialIcon } from '@/components/brand-icons'
import { DUTY_ICONS, POSITION_GLYPH_BY_ID } from '@/components/role-icons/duty-icons'
import { GLYPHS, OWNER_BLOCK_SIZE, OWNER_BLOCKS } from '@/components/role-icons/glyphs'
import { DutyIcon, PositionIcon, positionGlyph } from '@/components/role-icons/role-icon'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const rolesDir = join(repoRoot, 'packages/roles/roles')
const positionsDir = join(repoRoot, 'packages/roles/positions')

/** 全部职责 id：`roles/<domain>/<slug>.yml` 里的 `id:`。 */
function allDutyIds(): string[] {
  const ids: string[] = []
  for (const domain of readdirSync(rolesDir)) {
    for (const file of readdirSync(join(rolesDir, domain)).filter((f) => f.endsWith('.yml'))) {
      const m = /^id:\s*(\S+)/m.exec(readFileSync(join(rolesDir, domain, file), 'utf8'))
      if (m?.[1] !== undefined) ids.push(m[1])
    }
  }
  return ids
}

/** 全部岗位模板：id、`icon`、包含的职责。 */
function allPositions(): { id: string; icon: string | undefined; roles: string[] }[] {
  return readdirSync(positionsDir)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => {
      const text = readFileSync(join(positionsDir, f), 'utf8')
      return {
        id: /^id:\s*(\S+)/m.exec(text)?.[1] ?? '',
        icon: /^icon:\s*(\S+)/m.exec(text)?.[1],
        roles: [...text.matchAll(/\{\s*role:\s*([\w.-]+)/g)].map((m) => m[1] as string),
      }
    })
}

describe('岗位与职责图标（WP213）', () => {
  it('每条职责都在对照表里，指向的图形真的有', () => {
    const ids = allDutyIds()
    expect(ids.length).toBeGreaterThanOrEqual(50)
    const missing = ids.filter((id) => DUTY_ICONS[id] === undefined)
    expect(missing, `这几条职责还没配图标：${missing.join('、')}`).toEqual([])
    for (const [id, spec] of Object.entries(DUTY_ICONS)) {
      expect(GLYPHS[spec.glyph], `${id} 指向的图形 ${spec.glyph} 不存在`).toBeDefined()
    }
  })

  it('每个岗位都有图标：模板 yml 的 icon + 负责人 / 普通成员', () => {
    for (const p of allPositions()) {
      expect(p.icon, `${p.id}.yml 没写 icon`).toBeDefined()
      expect(GLYPHS[p.icon as string], `${p.id} 的 icon ${p.icon} 不存在`).toBeDefined()
      expect(positionGlyph(p.id, p.icon)).toBe(p.icon)
    }
    for (const id of ['owner', 'member']) expect(positionGlyph(id)).toBe(id)
    for (const glyph of Object.values(POSITION_GLYPH_BY_ID)) expect(GLYPHS[glyph]).toBeDefined()
  })

  it('角标都能在官网图库里找到，渲染出来的是本地图、不是外站地址', () => {
    const badges = [...new Set(Object.values(DUTY_ICONS).flatMap((s) => s.badge ?? []))]
    expect(badges).toContain('amazon')
    for (const b of badges) expect(hasOfficialIcon(b), `${b} 没有官网图`).toBe(true)
    for (const [id, spec] of Object.entries(DUTY_ICONS)) {
      const { container, unmount } = render(<DutyIcon role_id={id} />)
      const svg = container.querySelector('svg') as SVGSVGElement
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('data-glyph')).toBe(spec.glyph)
      const img = container.querySelector('image')
      if (spec.badge === undefined) {
        expect(img, `${id} 不该有角标`).toBeNull()
      } else {
        const href = img?.getAttribute('href') ?? ''
        expect(href, `${id} 的角标没图`).not.toBe('')
        // 运行时一条外发请求都不许有（本地优先 / 隐私 / 离线）
        expect(href.startsWith('http'), `${id} 的角标指到外站：${href.slice(0, 60)}`).toBe(false)
        // 角标下面垫着一块浅色圆底（黑底的官方图在深色主题下也看得见）
        expect(container.innerHTML).toContain('var(--ws-badge-plate')
      }
      unmount()
    }
  })

  it('同一个岗位里没有两枚一样的图标，也不和岗位自己那枚撞', () => {
    for (const p of allPositions()) {
      const seen = new Map<string, string>()
      for (const role of p.roles) {
        const spec = DUTY_ICONS[role]
        if (spec === undefined) continue
        const key = `${spec.glyph}+${spec.badge ?? ''}`
        expect(seen.get(key), `${p.id} 里 ${role} 与 ${seen.get(key)} 的图标一样`).toBeUndefined()
        seen.set(key, role)
        // 不挂角标的职责不许直接用岗位那枚（左栏里会和上面那一行一模一样）
        if (spec.badge === undefined) expect(spec.glyph, `${p.id} / ${role}`).not.toBe(p.icon)
      }
    }
  })

  it('负责人那三块与品牌标记的真几何对得上（最左两列 b1 / b2 / b3，等比缩进 24 网格）', () => {
    const pick = [BLOCKS[0], BLOCKS[1], BLOCKS[2]].map((b) => b as { x: number; y: number })
    const minX = Math.min(...pick.map((b) => b.x))
    const minY = Math.min(...pick.map((b) => b.y))
    const s = 20 / (Math.max(...pick.map((b) => b.x)) - minX + BLOCK_SIZE)
    const inset = 0.875
    pick.forEach((b, i) => {
      const [x, y] = OWNER_BLOCKS[i] as readonly [number, number]
      expect(x).toBeCloseTo(2 + (b.x - minX) * s + inset, 1)
      expect(y).toBeCloseTo(2 + (b.y - minY) * s + inset, 1)
    })
    expect(OWNER_BLOCK_SIZE).toBeCloseTo(BLOCK_SIZE * s - 2 * inset, 1)
  })

  it('岗位图标：接口给的优先 → 模板 id → 第一条认得出的职责 → generic', () => {
    expect(positionGlyph('pos_x', 'ads')).toBe('ads')
    expect(positionGlyph('customer-care')).toBe('customer-care')
    expect(positionGlyph('pos_custom', undefined, ['nope.x', 'b2b.sales'])).toBe('b2b.sales')
    expect(positionGlyph('pos_custom', 'not-a-glyph', ['kol.youtube'])).toBe('kol-marketing')
    expect(positionGlyph('pos_custom')).toBe('generic')
    const { container } = render(<DutyIcon role_id="future.unknown" />)
    expect(container.querySelector('svg')?.getAttribute('data-glyph')).toBe('generic')
  })

  it('选中态：点睛那一笔走 --ia，selected 时设成品牌色', () => {
    const { container, rerender } = render(<PositionIcon position_id="kol-marketing" />)
    const svg = () => container.querySelector('svg') as SVGSVGElement
    expect(svg().innerHTML).toContain('var(--ia, currentColor)')
    expect(svg().style.getPropertyValue('--ia')).toBe('')
    rerender(<PositionIcon position_id="kol-marketing" selected />)
    expect(svg().style.getPropertyValue('--ia')).toBe('var(--ws-brand)')
    // 线描：24 网格、1.75 线宽、圆角端点
    expect(svg().getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg().getAttribute('stroke-width')).toBe('1.75')
    expect(svg().getAttribute('stroke-linecap')).toBe('round')
  })
})
