/**
 * 52 O2：顶栏的**品牌切换器**。
 *
 * 三条：
 *
 * 1. **个人用户看不到它**（52 O1）。一个人、一个品牌的时候整块不渲染——
 *    "组织"这一层对他不存在，多一个下拉只是多一个要理解的东西。
 * 2. **只列进得去的品牌**。下拉里是服务端按"本人有没有成员资格"筛过的那几个
 *    （`GET /v1/orgs/:id/brands`），不是这家公司的全部品牌。
 * 3. **切换 = 整站重载**。换品牌要换的是首页、岗位、连接、知识、设置全部——
 *    与其一页一页去失效缓存，不如让浏览器从头拉一遍：少一处漏掉就少一次串味
 *    （52 O2「不混」）。
 *
 * **没有跨品牌的合并视图**：这里不显示"两个品牌一共多少张待审卡"那种数。
 * 想看全公司只有公司页的那张品牌一览（52 §3）。
 */
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Store } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { type BrandView, listBrands, listOrganizations, switchBrand } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

/**
 * 当前这家公司与本人进得去的品牌。
 *
 * 一个人可能在多家公司（帮朋友看店），这里只认**第一家**——顶栏一次只显示一个
 * 品牌名，再叠一层"哪家公司"就成了两级下拉。多公司的完整处理留给公司页。
 */
export function useBrands(): {
  org_id?: string
  brands: BrandView[]
  /** 52 O1：一个人一个品牌 = 个人用户，界面上一律不显示组织与切换器。 */
  solo: boolean
  loading: boolean
} {
  const orgs = useQuery({
    queryKey: ['orgs'],
    queryFn: () => listOrganizations(),
    retry: false,
  })
  const org = orgs.data?.[0]
  const brands = useQuery({
    queryKey: ['orgs', org?.id, 'brands'],
    enabled: org !== undefined,
    queryFn: () => listBrands(org?.id ?? ''),
    retry: false,
  })
  return {
    ...(org === undefined ? {} : { org_id: org.id }),
    brands: brands.data ?? [],
    solo: org?.solo ?? true,
    loading: orgs.isLoading || brands.isLoading,
  }
}

export function BrandSwitcher(): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const { org_id, brands, solo } = useBrands()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)

  // 52 O1：个人用户（一个人、一个品牌）界面上一律不显示组织概念
  if (solo || org_id === undefined || brands.length <= 1) return null
  const current = brands.find((b) => b.current) ?? brands[0]
  if (current === undefined) return null

  const go = (workspace_id: string): void => {
    setOpen(false)
    if (workspace_id === current.workspace_id) return
    switchBrand(org_id, workspace_id)
      .then(() => {
        // 整站重载：换品牌要换的东西太多，一页一页失效缓存漏一处就串味
        globalThis.location?.reload()
      })
      .catch(() => {
        setFailed(true)
      })
  }

  return (
    <div className="relative mr-auto flex items-center gap-2" data-testid="brand-switcher">
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('brand.switch')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <Store aria-hidden className="size-4" />
        <span className="max-w-40 truncate font-medium" data-testid="brand-current">
          {current.name}
        </span>
        <ChevronsUpDown aria-hidden className="size-3 opacity-60" />
      </Button>
      {open ? (
        // 一个最朴素的下拉：一个按钮 + 一张列表。不用带浮层引擎的那一套——
        // 顶栏这一个下拉只有"列几个名字、点一个"这一件事，多一层机制就多一层会坏的东西。
        <ul
          role="menu"
          data-testid="brand-menu"
          className="absolute top-full left-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1 shadow-md"
        >
          <li className="px-2 py-1.5 text-xs text-muted-foreground">{t('brand.switch.hint')}</li>
          <Separator className="my-1" />
          {brands.map((b) => (
            <li key={b.workspace_id}>
              <button
                type="button"
                role="menuitem"
                data-testid={`brand-option-${b.workspace_id}`}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                  b.current ? 'font-medium' : 'hover:bg-accent',
                )}
                onClick={() => {
                  go(b.workspace_id)
                }}
              >
                {b.current ? (
                  <Check aria-hidden className="size-4" />
                ) : (
                  <span aria-hidden className="size-4" />
                )}
                <span className="truncate">{b.name}</span>
                {b.pending_approvals > 0 ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {b.pending_approvals}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          <Separator className="my-1" />
          <li>
            <button
              type="button"
              role="menuitem"
              data-testid="brand-manage"
              className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false)
                navigate('/org?tab=brands')
              }}
            >
              {t('brand.switch.manage')}
            </button>
          </li>
        </ul>
      ) : null}
      {failed ? (
        <span role="alert" className="text-xs text-destructive" data-testid="brand-switch-failed">
          {t('brand.switch.failed')}
        </span>
      ) : null}
    </div>
  )
}
