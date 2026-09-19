/**
 * WP117（66 断点 #10 / #11）：**一条合作的线程页**。
 *
 * 断点 #10：以前红人的一切都堆在「面板」那一长条里，没有"一条合作"这个东西
 * 可以点开——而红人营销干活的单位恰恰就是一条合作。断点 #11：交付物验收、
 * 追踪链接这几步**界面上根本没有入口**，只在模拟场景（接口级）里被验证过，
 * 路由早就在那儿了。
 *
 * 这一屏就是那个单位：阶段在哪、交付物交了没、验收结论、追踪链接与它带来的数。
 * 参照 KOLAgents 的合作详情，但只留这个阶段真用得上的四块。
 *
 * 两条纪律：
 *
 * 1. **每一个动作都有回执，失败照实说**（`KolError` / `KolReceipt`）。
 *    这一屏是新写的，从第一行起就不许再出现 66 断点 #5 那种"点了没反应"。
 * 2. **验收结论不是直接改库**：它提的是一条 `kol_deliverable_review` 变更，
 *    出一张待人批的卡。所以按钮上写的是「提交验收」，回执里写「在待办里等你批」——
 *    不写「已通过」，因为还没有。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Link2, Package } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  advanceKolCollaboration,
  createKolTrackedLink,
  getKolCollaborations,
  getKolCreators,
  getKolDeliverables,
  getKolTrackedLinks,
  type KolChannelId,
  reviewKolDeliverable,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { errorText, KolError, KolReceipt } from './kol-shared'

/** 合作阶段的下一步（合法迁移表的真源在服务端；这里只是按钮上那几个常见的去处）。 */
const NEXT_STAGES: Readonly<Record<string, string[]>> = {
  sourced: ['contacted', 'declined'],
  contacted: ['replied', 'declined'],
  replied: ['negotiating', 'declined'],
  negotiating: ['agreed', 'declined'],
  agreed: ['delivering', 'declined'],
  delivering: ['delivered'],
  delivered: ['closed'],
}

/** 三个验收结论。`pending` 不在这里——那是"还没结论"，不是一个可以点的结论。 */
const REVIEWS = [
  { id: 'approved', zh: '通过' },
  { id: 'changes_requested', zh: '要改' },
  { id: 'rejected', zh: '不合格' },
] as const

export function CollabThread({
  assignment,
  channel,
  id,
  onBack,
}: {
  assignment: string
  channel: KolChannelId
  id: string
  onBack: () => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const [notes, setNotes] = useState('')
  const [linkUrl, setLinkUrl] = useState('')

  const collabs = useQuery({
    queryKey: ['kol-collaborations', assignment, channel],
    queryFn: () => getKolCollaborations({ channel }, assignment),
  })
  const library = useQuery({
    queryKey: ['kol-creators', assignment, channel],
    queryFn: () => getKolCreators({ channel }, assignment),
  })
  const deliverables = useQuery({
    queryKey: ['kol-deliverables', id],
    queryFn: () => getKolDeliverables({ collaboration_id: id }, assignment),
  })
  const links = useQuery({
    queryKey: ['kol-links', id],
    queryFn: () => getKolTrackedLinks({ collaboration_id: id }, assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
    void client.invalidateQueries({ queryKey: ['kol-deliverables', id] })
    void client.invalidateQueries({ queryKey: ['kol-links', id] })
    void client.invalidateQueries({ queryKey: ['cards'] })
  }

  const advance = useMutation({
    mutationFn: (stage: string) => advanceKolCollaboration(id, stage, assignment),
    onSuccess: (row) => {
      setError(undefined)
      setReceipt(`推到「${t(`kol.stage.${row.stage}`)}」了。`)
      refresh()
    },
    // 非法跳转回的是一句人话（"还没建联就说交付完了"），照实显示
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这一步没推动。'))
    },
  })

  const review = useMutation({
    mutationFn: (input: { deliverable_id: string; review: (typeof REVIEWS)[number]['id'] }) =>
      reviewKolDeliverable(
        input.deliverable_id,
        { review: input.review, ...(notes.trim() === '' ? {} : { notes: notes.trim() }) },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setNotes('')
      setReceipt(
        out.staged
          ? '验收结论提上去了，在待办里等你批。批了才算数。'
          : (out.message ?? '这条结论没提上去。'),
      )
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '验收结论没提上去。'))
    },
  })

  const addLink = useMutation({
    mutationFn: () =>
      createKolTrackedLink({ collaboration_id: id, url: linkUrl.trim() }, assignment),
    onSuccess: (row) => {
      setError(undefined)
      setLinkUrl('')
      setReceipt(`追踪链接建好了：${row.url}。归因全靠它。`)
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '追踪链接没建成。'))
    },
  })

  const collab = collabs.data?.rows.find((c) => c.id === id)
  const who = library.data?.rows.find((r) => r.creator_id === collab?.creator_id)

  if (collabs.isPending) return <Skeleton className="h-48 w-full" />
  if (collab === undefined) {
    return (
      <Card data-testid="kol-collab-thread">
        <CardContent className="flex flex-col gap-2 py-4 text-sm">
          <KolError error="这条合作不在当前渠道的清单里（可能被清空了，或者换了渠道）。" />
          <div>
            <Button size="xs" variant="ghost" onClick={onBack}>
              <ArrowLeft className="size-3" aria-hidden />
              回合作清单
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="kol-collab-thread" data-collab={id} data-stage={collab.stage}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-sm">
          {who?.display_name ?? collab.creator_id}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t(`kol.channel.${collab.channel}`)} · {t(`kol.stage.${collab.stage}`)}
            {collab.budget === undefined ? '' : ` · ${collab.budget} ${collab.currency}`}
          </span>
        </CardTitle>
        <Button size="xs" variant="ghost" data-testid="kol-thread-back" onClick={onBack}>
          <ArrowLeft className="size-3" aria-hidden />
          回合作清单
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* ① 阶段：推到下一步 */}
        <section data-testid="kol-thread-stage">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">现在到哪一步</h4>
          <div className="flex flex-wrap gap-1">
            {(NEXT_STAGES[collab.stage] ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground">这条合作已经结案了。</span>
            ) : null}
            {(NEXT_STAGES[collab.stage] ?? []).map((next) => (
              <Button
                key={next}
                size="xs"
                variant="outline"
                data-testid="kol-thread-next"
                data-next={next}
                disabled={advance.isPending}
                onClick={() => {
                  advance.mutate(next)
                }}
              >
                {t(`kol.stage.${next}`)}
              </Button>
            ))}
          </div>
        </section>

        {/* ② 交付物与验收（66 断点 #11：以前界面上没有这个入口） */}
        <section data-testid="kol-thread-deliverables">
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Package className="size-3" aria-hidden />
            交付物
          </h4>
          {deliverables.isPending ? <Skeleton className="h-10 w-full" /> : null}
          {(deliverables.data?.rows ?? []).length === 0 && !deliverables.isPending ? (
            <p className="text-xs text-muted-foreground">还没有交付物。</p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {(deliverables.data?.rows ?? []).map((d) => (
              <li key={d.id} className="border-b pb-2" data-testid="kol-thread-deliverable">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className="font-medium">{d.kind}</span>
                  <span className="text-muted-foreground">
                    {t(`kol.review.${d.review}`)} · 交稿 {d.due_at.slice(0, 10)}
                  </span>
                  {d.url === undefined ? null : (
                    <a className="underline" href={d.url} target="_blank" rel="noreferrer">
                      看一眼
                    </a>
                  )}
                </div>
                {d.review === 'pending' ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {REVIEWS.map((r) => (
                      <Button
                        key={r.id}
                        size="xs"
                        variant={r.id === 'approved' ? 'outline' : 'ghost'}
                        data-testid="kol-thread-review"
                        data-review={r.id}
                        disabled={
                          review.isPending ||
                          // 要改 / 不合格必须写清楚改什么——不写就点不动，而不是提上去一句空话
                          (r.id !== 'approved' && notes.trim() === '')
                        }
                        onClick={() => {
                          review.mutate({ deliverable_id: d.id, review: r.id })
                        }}
                      >
                        {r.zh}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {(deliverables.data?.rows ?? []).some((d) => d.review === 'pending') ? (
            <Input
              className="mt-1"
              value={notes}
              placeholder="要改 / 不合格的话，逐条写清楚哪里不对（广告标识、禁用词、链接、折扣码）"
              data-testid="kol-thread-notes"
              onChange={(e) => {
                setNotes(e.target.value)
              }}
            />
          ) : null}
        </section>

        {/* ③ 追踪链接与它带来的数（归因） */}
        <section data-testid="kol-thread-links">
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Link2 className="size-3" aria-hidden />
            追踪链接
          </h4>
          {(links.data?.rows ?? []).length === 0 && !links.isPending ? (
            <p className="text-xs text-muted-foreground">
              还没有追踪链接。没有它，这条合作带来多少单是算不出来的。
            </p>
          ) : null}
          <ul className="flex flex-col gap-1 text-xs">
            {(links.data?.rows ?? []).map((l) => (
              <li key={l.id} data-testid="kol-thread-link" className="flex flex-wrap gap-x-2">
                <span className="truncate font-mono">{l.url}</span>
                <span className="text-muted-foreground">
                  {l.clicks} 次点击 · {l.orders} 单 · {l.revenue}
                  {l.affiliate_code === undefined ? '' : ` · 码 ${l.affiliate_code}`}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex items-center gap-2">
            <Input
              value={linkUrl}
              placeholder="落地页地址（https://…）"
              data-testid="kol-thread-link-url"
              onChange={(e) => {
                setLinkUrl(e.target.value)
              }}
            />
            <Button
              size="xs"
              variant="outline"
              data-testid="kol-thread-link-add"
              disabled={linkUrl.trim() === '' || addLink.isPending}
              onClick={() => {
                addLink.mutate()
              }}
            >
              建一条
            </Button>
          </div>
        </section>

        <KolError error={error} testid="kol-thread-error" />
        <KolReceipt text={receipt} testid="kol-thread-receipt" />
      </CardContent>
    </Card>
  )
}
