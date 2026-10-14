/**
 * WP311（决策 507）：带品牌的工作台链接（`…/matters/mtr_1?brand=ws_2`）。
 *
 * IM（飞书 / 钉钉 / 企业微信）回复里的链接带着它指向的品牌（WP308 跨品牌点名）。打开时：
 *
 * - 就是当前品牌 → 把 `brand` 从地址里拿掉，照常开；
 * - 是本人进得去的另一个品牌 → 先切过去（52 O2：换会话、整站重载），再开链接里那一页；
 * - 不存在 / 没权限 → 留在当前品牌、回首页，顶上照实说一句（{@link useBrandLinkNotice}）。
 *
 * 切的时候不画链接那一页（那一页的 id 是另一个品牌的，先画出来只会是一屏「找不到」）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { listBrands, listOrganizations, switchBrand } from '@/lib/api'

/** 地址里那一格的名字。 */
export const BRAND_PARAM = 'brand'

/** 地址里要切去的品牌（没有 / 空 = `undefined`）。 */
export function brandOfSearch(search: string): string | undefined {
  const v = new URLSearchParams(search).get(BRAND_PARAM)?.trim()
  return v === undefined || v === '' ? undefined : v
}

/** 同一个地址去掉 `brand` 那一格（别的参数与 `#` 原样留着）。 */
export function withoutBrand(loc: { pathname: string; search: string; hash: string }): string {
  const params = new URLSearchParams(loc.search)
  params.delete(BRAND_PARAM)
  const rest = params.toString()
  return `${loc.pathname}${rest === '' ? '' : `?${rest}`}${loc.hash}`
}

/** 本人进得去的品牌里找它在哪家公司（服务端只列有成员资格的品牌）。找不到 = `undefined`。 */
export async function orgOfBrand(workspace_id: string): Promise<string | undefined> {
  for (const org of await listOrganizations()) {
    const brands = await listBrands(org.id)
    if (brands.some((b) => b.workspace_id === workspace_id)) return org.id
  }
  return undefined
}

/* ── 顶上那一句（切不过去时）：只在内存里，关掉或换一页就没了 ── */

export type BrandLinkNotice = 'missing' | 'failed'

let notice: BrandLinkNotice | undefined
const listeners = new Set<() => void>()
const publish = (next: BrandLinkNotice | undefined): void => {
  notice = next
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

export function useBrandLinkNotice(): BrandLinkNotice | undefined {
  return useSyncExternalStore(
    subscribe,
    () => notice,
    () => notice,
  )
}

export function closeBrandLinkNotice(): void {
  publish(undefined)
}

/** 测试用。 */
export function resetBrandLink(): void {
  publish(undefined)
}

/**
 * 处理地址里的 `brand`。`current` = 当前会话的品牌（会话还没到时 `undefined`，先不动）。
 * 回 `true` = 正在切（调用方先别画链接那一页）。
 */
export function useBrandLink(current: string | undefined): boolean {
  const location = useLocation()
  const navigate = useNavigate()
  const wanted = brandOfSearch(location.search)
  const [settled, setSettled] = useState<string | undefined>(undefined)
  const started = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (wanted === undefined || current === undefined) return
    const rest = withoutBrand(location)
    if (wanted === current) {
      navigate(rest, { replace: true })
      return
    }
    // 同一个链接只切一次（StrictMode 下 effect 会跑两遍）
    const key = `${wanted}|${rest}`
    if (started.current === key) return
    started.current = key
    const giveUp = (why: BrandLinkNotice): void => {
      publish(why)
      setSettled(key)
      // 链接里那一页是另一个品牌的，留在当前品牌只会「找不到」——回首页
      navigate('/', { replace: true })
    }
    orgOfBrand(wanted)
      .then(async (org_id) => {
        if (org_id === undefined) {
          giveUp('missing')
          return
        }
        await switchBrand(org_id, wanted)
        // 整站重载到链接里那一页（52 O2：不一页一页失效缓存）
        globalThis.location?.assign(rest)
      })
      .catch(() => {
        giveUp('failed')
      })
  }, [wanted, current, location, navigate])

  if (wanted === undefined || current === undefined || wanted === current) return false
  return settled !== `${wanted}|${withoutBrand(location)}`
}
