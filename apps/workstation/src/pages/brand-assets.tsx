/**
 * WP268（决策 213）：**品牌素材库**页（`/brand-assets`）——图片的统一来源。
 *
 * AI 出的图（待挑 / 选中 / 不要）、人传的图（这一页或事项里拖进来的）、店里商品图都在这里；
 * 点一张看来源、提示词、模型、积分、传没传到店铺「文件」、挂在网站哪一格。传图：按钮或直接拖进来。
 * 界面少字：一行标题 + 问号，筛选是一排小签。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { ExternalLink, ImagePlus, Store } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AuthedImage } from '@/components/images/authed-image'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import {
  BRAND_ASSET_ACCEPT,
  BRAND_ASSET_MAX_BYTES,
  type BrandAssetRow,
  listBrandAssets,
  uploadBrandAsset,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Filter = 'all' | 'generated' | 'uploaded' | 'external' | 'picked'
const FILTERS: Filter[] = ['all', 'generated', 'uploaded', 'external', 'picked']

export const BRAND_ASSETS_KEY = ['brand-assets'] as const

export function BrandAssetsPage(): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [over, setOver] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const list = useQuery({
    queryKey: [...BRAND_ASSETS_KEY, filter],
    queryFn: () =>
      listBrandAssets({
        ...(filter === 'picked'
          ? { picked_only: true }
          : filter === 'all'
            ? {}
            : { source: filter }),
        limit: 200,
      }),
  })
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const ok = files.filter((f) => f.size <= BRAND_ASSET_MAX_BYTES)
      if (ok.length < files.length) setProblem(t('assets.too_big'))
      for (const f of ok) await uploadBrandAsset(f)
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: BRAND_ASSETS_KEY })
    },
  })
  const rows = (list.data?.rows ?? []).filter((r) => r.status !== 'rejected' || filter !== 'picked')
  const selected = rows.find((r) => r.id === open)
  const add = (files: FileList | null | undefined): void => {
    setProblem(undefined)
    const images = [...(files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (images.length > 0) upload.mutate(images)
  }

  return (
    <div
      className="mx-auto flex w-full max-w-[1080px] flex-col gap-4"
      data-testid="brand-assets-page"
    >
      <header className="flex items-center gap-2">
        <h1 className="flex items-center gap-1 text-lg font-semibold text-ws-ink">
          {t('assets.title')}
          <Hint text={t('assets.hint')} testId="brand-assets-hint" />
        </h1>
        <Button
          size="sm"
          className="ml-auto gap-1.5"
          disabled={upload.isPending}
          data-testid="brand-assets-upload"
          onClick={() => {
            picker.current?.click()
          }}
        >
          <ImagePlus aria-hidden className="size-4" />
          {upload.isPending ? t('assets.uploading') : t('assets.upload')}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={BRAND_ASSET_ACCEPT}
          className="hidden"
          onChange={(e) => {
            add(e.target.files)
            e.target.value = ''
          }}
        />
      </header>
      <div className="flex flex-wrap gap-1.5" role="tablist" data-testid="brand-assets-filters">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => {
              setFilter(f)
            }}
            className={cn(
              'h-7 rounded-full px-3 text-[12.5px]',
              filter === f
                ? 'bg-ws-ink text-ws-paper'
                : 'bg-ws-surface text-ws-body ring-1 ring-ws-line hover:bg-muted',
            )}
          >
            {t(`assets.filter.${f}`)}
          </button>
        ))}
      </div>
      {problem === undefined ? null : (
        <p role="alert" className="text-[12.5px] text-destructive">
          {problem}
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
        <section
          aria-label={t('assets.title')}
          data-testid="brand-assets-grid"
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes('Files')) {
              e.preventDefault()
              setOver(true)
            }
          }}
          onDragLeave={() => {
            setOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            add(e.dataTransfer.files)
          }}
          className={cn(
            'grid min-h-[240px] grid-cols-2 content-start gap-3 rounded-2xl p-1 sm:grid-cols-3 lg:grid-cols-4',
            over && 'bg-ws-tint outline-2 outline-dashed outline-ws-brand/50',
          )}
        >
          {rows.length === 0 && !list.isPending ? (
            <p className="col-span-full py-16 text-center text-[13px] text-ws-muted-fg">
              {over ? t('assets.drop') : t('assets.empty')}
            </p>
          ) : null}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid="brand-asset"
              aria-pressed={open === r.id}
              onClick={() => {
                setOpen(open === r.id ? undefined : r.id)
              }}
              className={cn(
                'group flex flex-col overflow-hidden rounded-xl bg-ws-card text-left ring-1 ring-ws-line transition-shadow hover:shadow-ws',
                open === r.id && 'ring-2 ring-ws-brand',
              )}
            >
              <AuthedImage src={r.file_url} alt={r.source_label} className="aspect-square w-full" />
              <span className="flex items-center gap-1.5 px-2.5 py-2 text-[12px]">
                <StatusDot row={r} />
                <span className="truncate text-ws-body">{r.source_label}</span>
                {r.shop_file === undefined ? null : (
                  <Store
                    aria-label={t('assets.detail.shop')}
                    className="ml-auto size-3.5 shrink-0 text-ws-good"
                  />
                )}
              </span>
            </button>
          ))}
        </section>
        {selected === undefined ? null : <AssetDetail row={selected} />}
      </div>
    </div>
  )
}

function StatusDot({ row }: { row: BrandAssetRow }): ReactNode {
  const { t } = useApp()
  const tone =
    row.status === 'picked' || row.status === 'published'
      ? 'bg-ws-good'
      : row.status === 'rejected'
        ? 'bg-ws-muted-fg/50'
        : 'bg-ws-warn'
  return (
    <span
      role="img"
      aria-label={t(`assets.status.${row.status}`)}
      title={t(`assets.status.${row.status}`)}
      className={cn('size-2 shrink-0 rounded-full', tone)}
    />
  )
}

function AssetDetail({ row }: { row: BrandAssetRow }): ReactNode {
  const { t } = useApp()
  const p = row.provenance
  const rows: [string, ReactNode][] = [
    [t('assets.detail.source'), `${row.source_label} · ${t(`assets.status.${row.status}`)}`],
    ...(p.model === undefined
      ? []
      : [[t('assets.detail.model'), p.model.model] as [string, ReactNode]]),
    ...(p.credits === undefined
      ? []
      : [[t('assets.detail.credits'), String(p.credits)] as [string, ReactNode]]),
    ...(row.width === undefined
      ? []
      : [[t('assets.detail.size'), `${row.width} × ${row.height ?? '?'}`] as [string, ReactNode]]),
    ...(row.shop_file === undefined
      ? []
      : [[t('assets.detail.shop'), row.shop_file.filename] as [string, ReactNode]]),
    ...(row.placed === undefined
      ? []
      : [
          [
            t('assets.detail.placed'),
            <span key="placed" className="flex flex-wrap items-center gap-1.5">
              {[row.placed.file, row.placed.section, row.placed.block].filter(Boolean).join(' · ')}
              {row.placed.preview_url === undefined ? null : (
                <a
                  href={row.placed.preview_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-ws-brand"
                >
                  {t('assets.detail.preview')}
                  <ExternalLink aria-hidden className="size-3" />
                </a>
              )}
            </span>,
          ] as [string, ReactNode],
        ]),
    ...(p.matter_id === undefined
      ? []
      : [
          [
            t('assets.detail.matter'),
            <Link key="m" to={`/matters/${p.matter_id}`} className="text-ws-brand">
              {p.matter_id}
            </Link>,
          ] as [string, ReactNode],
        ]),
  ]
  return (
    <aside
      className="sticky top-4 flex w-[300px] flex-col gap-3 self-start rounded-2xl bg-ws-card p-3 ring-1 ring-ws-line"
      data-testid="brand-asset-detail"
    >
      <AuthedImage
        src={row.file_url}
        alt={row.source_label}
        className="w-full rounded-xl object-contain"
      />
      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ws-muted-fg">{k}</dt>
            <dd className="min-w-0 break-words text-ws-body">{v}</dd>
          </div>
        ))}
      </dl>
      {p.prompt === undefined ? null : (
        <details className="text-[12.5px]">
          <summary className="cursor-pointer text-ws-muted-fg">{t('assets.detail.prompt')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-ws-body">{p.prompt}</p>
        </details>
      )}
    </aside>
  )
}
