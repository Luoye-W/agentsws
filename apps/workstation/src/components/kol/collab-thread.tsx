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
import { ArrowLeft, Coins, Link2, Mail, MailOpen, Package } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  advanceKolCollaboration,
  createKolDeliverable,
  createKolTrackedLink,
  getKolCollaborations,
  getKolCreators,
  getKolDeliverables,
  getKolExchanges,
  getKolTrackedLinks,
  type KolChannelId,
  type KolExchangeData,
  quoteKolCollaboration,
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

/**
 * WP117b（66 复测 #19）：**回信落在哪一类**，以及这一类接下来该干什么。
 *
 * 分类是服务端算的（`kol-core` 的 `classifyReply`，与真邮箱来的红人信同一个
 * 分类器），这里只负责把它说成人话。**建议不是动作**：下面那一句写的是
 * "该干什么"，点不动——真要推进阶段得用上面那一排按钮。
 */
const REPLY_CLASS: Readonly<Record<string, { zh: string; next: string; tone: string }>> = {
  interested: { zh: '感兴趣', next: '推到「谈条件中」，然后聊具体怎么做。', tone: 'good' },
  wants_quote: {
    zh: '要报价',
    next: '议价这一步永远要人点头：推到「谈条件中」，把预算写在合作上。',
    tone: 'warn',
  },
  declined: { zh: '谢绝了', next: '标成「谢绝了」，跟进节奏就此打住。', tone: 'bad' },
  already_working: { zh: '已经在谈', next: '先在库里查一遍，别让两个人同时谈同一个人。', tone: '' },
  cold_inbound: { zh: '陌生来信', next: '先给他打个分，再决定要不要谈。', tone: '' },
  spam: { zh: '垃圾邮件', next: '丢掉，不进库。', tone: '' },
  unknown: { zh: '看不出意思', next: '这封得你自己读一遍。', tone: '' },
}

/** 三档跟进信的人话（跟进节奏在界面上看得见的那一半）。 */
const STEP_ZH: Readonly<Record<string, string>> = {
  first: '首封',
  follow_up: '3 天跟进',
  final: '7 天收尾',
}

/**
 * **跟进节奏现在走到哪一步**（66 复测 #19 的留尾 3）。
 *
 * 规矩只有一句：无回复时 3 天发第二封、7 天发第三封，**拒绝或退订即停**，
 * 一共最多三封。这个函数把往来记录翻成那一句话——以前它只写在服务端的
 * `sweepSequences` 里，界面上一个字都看不见，于是人不知道"系统还会不会再发"。
 */
export function cadenceText(rows: readonly KolExchangeData[]): string {
  const sent = rows.filter((r) => r.direction === 'out')
  const replies = rows.filter((r) => r.direction === 'in')
  if (replies.some((r) => r.opt_out === true))
    return '他说过别再发了 —— 跟进已经停了，一封都不会再发。'
  if (replies.some((r) => r.bounce_reason !== undefined))
    return '地址退信 —— 跟进已经停了，先把联系方式换一个。'
  if (replies.some((r) => r.reply_class === 'declined'))
    return '他谢绝了 —— 跟进已经停了。'
  if (replies.length > 0) return '他回过话了 —— 自动跟进停止，接下来由你来接。'
  if (sent.length === 0) return '还没发过信 —— 跟进节奏还没开始。'
  if (sent.length === 1) return '发过 1 封，没有回音 —— 3 天后自动起草第二封（仍要你批）。'
  if (sent.length === 2) return '发过 2 封，没有回音 —— 7 天后自动起草最后一封（仍要你批）。'
  return '三封都发过了 —— 不会再发（不许无限骚扰）。'
}

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
  const [deliverableUrl, setDeliverableUrl] = useState('')
  const [budget, setBudget] = useState('')

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
  // WP117b（66 复测 #19）：这条合作到底来往过什么
  const exchanges = useQuery({
    queryKey: ['kol-exchanges', id],
    queryFn: () => getKolExchanges({ collaboration_id: id }, assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
    void client.invalidateQueries({ queryKey: ['kol-deliverables', id] })
    void client.invalidateQueries({ queryKey: ['kol-links', id] })
    void client.invalidateQueries({ queryKey: ['kol-exchanges', id] })
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

  /*
   * 66 断点 #11 的剩余：**登记交付物界面上没有入口。**
   *
   * 路由早就在那儿了，可合作线程上只有"验收"没有"登记"——于是"谈成 → 交稿 →
   * 验收"这条链在界面上到第二步就断了（只能拿 curl 造一条）。交稿时间不给就
   * 按一周后：一个能改的默认值，比逼人先填一个日期才能往下走强。
   */
  const addDeliverable = useMutation({
    mutationFn: (kind: string) =>
      createKolDeliverable(
        {
          collaboration_id: id,
          kind,
          due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          ...(deliverableUrl.trim() === '' ? {} : { url: deliverableUrl.trim() }),
        },
        assignment,
      ),
    onSuccess: (row) => {
      setError(undefined)
      setDeliverableUrl('')
      setReceipt(`登记好了：一条${row.kind}，交稿 ${row.due_at.slice(0, 10)}。交了就能验收。`)
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这条交付物没登记上。'))
    },
  })

  /*
   * 66 复测 #19：**议价卡**（money 排版）。
   *
   * 他回信说"你们预算多少"的时候，界面上以前没有任何地方能接这句话——
   * 于是这条链在"要报价"那一步就断了。现在填一个数 → 出一张 money 卡 →
   * **批了才落**：预算与「谈条件中」由施行那一跳写，不是这里先写了再说。
   */
  const quote = useMutation({
    mutationFn: () => quoteKolCollaboration(id, { budget: Number(budget) }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(
        out.staged
          ? '议价提上去了，在待办里等你批（那张卡上写着要付多少钱）。批了这条合作才进「谈条件中」。'
          : (out.message ?? '这个数没提上去。'),
      )
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这个数没提上去。'))
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

        {/*
          ② 往来（WP117b，66 复测 #19）：这条合作到底来往过什么。
          我们发的那几封、他回的那几封、每一封入站的意向分类，外加跟进节奏
          现在走到哪一步。这一块在它之前**根本不存在**——于是"发信 → 回信 →
          分类 → 议价"这条链在界面上无从验证。
        */}
        <section data-testid="kol-thread-exchanges">
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Mail className="size-3" aria-hidden />
            往来
          </h4>
          {exchanges.isPending ? <Skeleton className="h-10 w-full" /> : null}
          {exchanges.error !== null ? (
            <KolError
              error={errorText(exchanges.error, '往来记录这次没取回来。')}
              testid="kol-thread-exchanges-error"
            />
          ) : null}
          {exchanges.error === null &&
          (exchanges.data?.rows ?? []).length === 0 &&
          !exchanges.isPending ? (
            <p className="text-xs text-muted-foreground">还没有来往过。先去候选池给他起一封开发信。</p>
          ) : null}
          <ol className="flex flex-col gap-2">
            {(exchanges.data?.rows ?? []).map((x) => {
              const klass = x.reply_class === undefined ? undefined : REPLY_CLASS[x.reply_class]
              return (
                <li
                  key={x.id}
                  className="border-l-2 pl-2"
                  data-testid="kol-thread-exchange"
                  data-direction={x.direction}
                  data-class={x.reply_class ?? ''}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                    <span className="flex items-center gap-1 font-medium">
                      {x.direction === 'out' ? (
                        <Mail className="size-3" aria-hidden />
                      ) : (
                        <MailOpen className="size-3" aria-hidden />
                      )}
                      {x.direction === 'out' ? '我们发的' : '他回的'}
                    </span>
                    {x.step === undefined ? null : (
                      <span className="text-muted-foreground">{STEP_ZH[x.step] ?? x.step}</span>
                    )}
                    <span className="text-muted-foreground">{x.at.slice(0, 16).replace('T', ' ')}</span>
                    {klass === undefined ? null : (
                      <span
                        className={
                          klass.tone === 'bad'
                            ? 'text-destructive'
                            : klass.tone === 'warn'
                              ? 'text-[var(--ws-warn)]'
                              : 'text-muted-foreground'
                        }
                        data-testid="kol-thread-reply-class"
                      >
                        {klass.zh}
                      </span>
                    )}
                    {x.bounce_reason === undefined ? null : (
                      <span className="text-destructive" data-testid="kol-thread-bounce">
                        退信 · {x.bounce_reason}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-medium">{x.subject}</div>
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground">{x.body}</p>
                  {/* 建议不是动作：写清楚下一步该干什么，但不给一个按钮替人点 */}
                  {klass === undefined ? null : (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      下一步：{klass.next}
                    </p>
                  )}
                </li>
              )
            })}
          </ol>
          <p
            className="mt-1 rounded-[var(--ws-radius-card)] bg-muted px-2 py-1 text-[11px] text-muted-foreground"
            data-testid="kol-thread-cadence"
          >
            跟进节奏：{cadenceText(exchanges.data?.rows ?? [])}
          </p>
        </section>

        {/* ③ 议价：填一个数 → 一张 money 卡 → 批了才作数 */}
        <section data-testid="kol-thread-quote">
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Coins className="size-3" aria-hidden />
            议价
          </h4>
          <p className="text-[11px] text-muted-foreground">
            {(exchanges.data?.rows ?? []).some((x) => x.reply_class === 'wants_quote')
              ? '他问了价钱。填一个数，出一张卡；这一步永远要你自己点头。'
              : '要谈钱就填一个数。合作的预算永远走卡，Agent 报不了价。'}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Input
              className="w-32"
              value={budget}
              inputMode="numeric"
              placeholder={`金额（${collab.currency}）`}
              aria-label="议价金额"
              data-testid="kol-thread-budget"
              onChange={(e) => {
                setBudget(e.target.value)
              }}
            />
            <Button
              size="xs"
              variant="outline"
              data-testid="kol-thread-quote-go"
              disabled={Number(budget) <= 0 || !Number.isFinite(Number(budget)) || quote.isPending}
              onClick={() => {
                quote.mutate()
              }}
            >
              提一张议价卡
            </Button>
          </div>
        </section>

        {/* ④ 交付物与验收（66 断点 #11：以前界面上没有这个入口） */}
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
          {/* 登记一条（以前只有"验收"没有"登记"，这条链在界面上到第二步就断了） */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input
              className="min-w-40 flex-1"
              value={deliverableUrl}
              placeholder="交付物链接（有了再填，没有也能先登记）"
              data-testid="kol-thread-deliverable-url"
              onChange={(e) => {
                setDeliverableUrl(e.target.value)
              }}
            />
            <Button
              size="xs"
              variant="outline"
              data-testid="kol-thread-deliverable-add"
              disabled={addDeliverable.isPending}
              onClick={() => {
                addDeliverable.mutate('video')
              }}
            >
              登记一条视频
            </Button>
          </div>
        </section>

        {/* ⑤ 追踪链接与它带来的数（归因） */}
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
