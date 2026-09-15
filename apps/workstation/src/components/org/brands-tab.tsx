/**
 * 52 O2 / O4：公司页的**品牌一览**，以及"加一个品牌"。
 *
 * 这是整个工作台**唯一**一处能同时看到两个品牌的地方（52 §3：不做跨品牌的合并
 * 视图、合并队列、合并知识库）。而且它看到的只有三个数——待审卡、告警、今日销售
 * ——不是两个品牌的数据混在一起，是两行各自的摘要。点一行就切过去。
 *
 * 三条：
 *
 * 1. **三个数每个品牌都算得出来**（WP66）。一个进程装多套品牌模块之后，每个品牌
 *    各有自己的活数据源，今日销售与它自己首页那个数字块读的是同一条查询。
 *    没有数只有一种意思：这个品牌还没连店、或者今天还没有单——照 36 §3 明说，
 *    不画一个 0。
 * 2. **复制不是共享**（52 O4）。"从某个品牌复制"搬的是职责分配与模型设置；
 *    范围不跟着走，**API key 不复制**，连接与知识一个字节都不复制——
 *    那是这个品牌自己的凭据与自己的事实。
 * 3. **一个品牌的时候也要在**。个人用户看到的是一句"要做第二个品牌就在这里加"，
 *    而不是一张空表。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Inbox, Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiClientError,
  type BrandView,
  copyBrandSettings,
  createBrand,
  listBrands,
  switchBrand,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Inbox
  label: string
  value: string
}): React.ReactNode {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label}</span>
      {value}
    </span>
  )
}

function BrandRow({
  brand,
  onOpen,
  busy,
}: {
  brand: BrandView
  onOpen(workspace_id: string): void
  busy: boolean
}): React.ReactNode {
  const { t } = useApp()
  return (
    <li
      data-testid={`brand-row-${brand.workspace_id}`}
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm',
        brand.current && 'border-primary bg-primary/5',
      )}
    >
      <span className="flex min-w-32 items-center gap-1 font-medium">
        {brand.current ? <Check aria-hidden className="size-4 text-primary" /> : null}
        {brand.name}
      </span>
      {brand.current ? (
        <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
          {t('org.brands.current')}
        </span>
      ) : null}
      <Stat icon={Inbox} label={t('org.brands.pending')} value={String(brand.pending_approvals)} />
      <Stat icon={AlertTriangle} label={t('org.brands.alerts')} value={String(brand.alerts)} />
      <span className="text-xs text-muted-foreground">
        {t('org.brands.sales')}:{' '}
        {brand.sales_today === undefined
          ? t('org.brands.sales_elsewhere')
          : `${brand.sales_today.amount.toFixed(2)} ${brand.sales_today.currency}`}
      </span>
      {brand.current ? null : (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          data-testid={`brand-open-${brand.workspace_id}`}
          onClick={() => {
            onOpen(brand.workspace_id)
          }}
        >
          {t('org.brands.open')}
        </Button>
      )}
    </li>
  )
}

export function BrandsTab({
  org_id,
  assignment,
}: {
  /** 没有公司（还没迁 / 装配里没有组织面）时整块不渲染。 */
  org_id?: string
  /** 制度这一层一律走所有者那条岗位（05 §3、31 §3.1）。 */
  assignment?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [switching, setSwitching] = useState(false)

  const brands = useQuery({
    queryKey: ['orgs', org_id, 'brands'],
    enabled: org_id !== undefined,
    queryFn: () => listBrands(org_id ?? '', assignment),
  })

  /**
   * 建品牌，然后（勾了的话）再复制一次设置。
   *
   * 分两步不是多此一举：复制那一步有**回执**（真搬了几条职责分配），界面要把那个
   * 数照实说出来。合成一步的话用户只会看到"建好了"，不知道到底有没有搬成。
   */
  const add = useMutation({
    mutationFn: async (): Promise<{ copied?: number; models?: number }> => {
      const brand = await createBrand(org_id ?? '', { name: name.trim() }, assignment)
      if (copyFrom === '') return {}
      const copy = await copyBrandSettings(org_id ?? '', brand.workspace_id, copyFrom, assignment)
      return { copied: copy.copied_assignments, models: copy.copied_model_providers ?? 0 }
    },
    onSuccess: async ({ copied, models }) => {
      setFailure(undefined)
      setName('')
      setCopyFrom('')
      // 回执照实说：职责分配搬了几条、模型设置搬了几条（key 没搬）
      const lines: string[] = []
      if (copied !== undefined)
        lines.push(copied === 0 ? t('org.brands.copy_none') : t('org.brands.copied', { n: copied }))
      if (models !== undefined && models > 0)
        lines.push(t('org.brands.copied_models', { n: models }))
      setReceipt(lines.length === 0 ? undefined : lines.join(' '))
      await client.invalidateQueries({ queryKey: ['orgs'] })
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  if (org_id === undefined) return null
  if (brands.data === undefined) return <Skeleton className="h-40 w-full" />

  const open = (workspace_id: string): void => {
    setSwitching(true)
    switchBrand(org_id, workspace_id, assignment)
      .then(() => {
        // 52 O2：整站重载——换品牌换的是首页、岗位、连接、知识、设置全部
        globalThis.location?.reload()
      })
      .catch((err: unknown) => {
        setSwitching(false)
        setFailure(err instanceof ApiClientError ? err.message : t('brand.switch.failed'))
      })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="org-brands">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1 text-sm">
            {t('org.brands.title')}
            <Hint text={t('org.brands.hint')} testId="org-brands-hint" />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {brands.data.length <= 1 ? (
            <p className="text-sm text-muted-foreground" data-testid="org-brands-solo">
              {t('org.brands.solo')}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {brands.data.map((b) => (
              <BrandRow key={b.workspace_id} brand={b} onOpen={open} busy={switching} />
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1 text-sm">
            {t('org.brands.add')}
            <Hint text={t('org.brands.add.hint')} />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-brand-name">{t('org.brands.add.name')}</Label>
            <Input
              id="new-brand-name"
              data-testid="new-brand-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-brand-copy" className="flex items-center gap-1">
              {t('org.brands.add.copy_from')}
              <Hint text={t('org.brands.add.copy_from.hint')} testId="brand-copy-hint" />
            </Label>
            <select
              id="new-brand-copy"
              data-testid="new-brand-copy"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={copyFrom}
              onChange={(e) => {
                setCopyFrom(e.target.value)
              }}
            >
              <option value="">{t('org.brands.add.copy_from.none')}</option>
              {brands.data.map((b) => (
                <option key={b.workspace_id} value={b.workspace_id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {failure === undefined ? null : (
            <p role="alert" className="text-destructive" data-testid="org-brands-error">
              {failure}
            </p>
          )}
          {receipt === undefined ? null : (
            <p className="text-xs text-muted-foreground" data-testid="org-brands-receipt">
              {receipt}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              data-testid="new-brand-submit"
              disabled={add.isPending || name.trim() === ''}
              onClick={() => {
                add.mutate()
              }}
            >
              <Plus aria-hidden className="size-4" />
              {t('org.brands.add.submit')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
