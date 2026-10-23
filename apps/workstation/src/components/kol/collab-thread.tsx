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
 *    出一张待人批的卡。所以按钮上写的是「提交验收」，回执里写「在卡片里等你批」——
 *    不写「已通过」，因为还没有。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Coins, Link2, Mail, MailOpen, Package, Truck, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
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
  recordKolPayment,
  reviewKolDeliverable,
  shipKolSample,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { errorText, KolError, KolReceipt, refreshCards } from './kol-shared'
import { CollabProgress } from './segmented-progress'

/** 合作阶段的下一步（合法迁移表的真源在服务端；这里只是按钮上那几个常见的去处）。 */
const NEXT_STAGES: Readonly<Record<string, string[]>> = {
  sourced: ['contacted', 'declined'],
  contacted: ['replied', 'declined'],
  replied: ['negotiating', 'declined'],
  negotiating: ['agreed', 'declined'],
  // WP299（决策 386）：寄样走「已寄样」；不寄样的直接开拍
  agreed: ['sample_sent', 'delivering', 'declined'],
  sample_sent: ['delivering', 'declined'],
  delivering: ['delivered'],
  delivered: ['closed'],
}

/** 三个验收结论。`pending` 不在这里——那是"还没结论"，不是一个可以点的结论。 */
/*
 * WP295（docs/96 P3：组件有出现 / 不出现规则）：线程里三块按阶段出，不再一直全摆着——
 * 「交付中」的合作上还挂着「他问了价钱，填一个数」，谈之前就让人登记交付物、建追踪链接。
 */
/** 议价：建联之后、谈成之前。 */
const QUOTE_STAGES: ReadonlySet<string> = new Set(['contacted', 'replied', 'negotiating'])
/** 交付物：谈成之后。 */
const DELIVERY_STAGES: ReadonlySet<string> = new Set([
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
])
/** 追踪链接：谈条件起（谈成之后、寄样之前就该建好）。 */
const LINK_STAGES: ReadonlySet<string> = new Set([
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
])

/** WP299（决策 386）：寄样：谈成之后（已寄样的只留那一行，不再给表）。 */
const SAMPLE_STAGES: ReadonlySet<string> = new Set(['agreed', 'sample_sent'])
/** WP299（决策 387）：付款：谈成之后（尾款常在交付后付）。 */
const PAYMENT_STAGES: ReadonlySet<string> = new Set([
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
])

/** 批过的付款加起来。 */
function paidOf(c: { payments?: { amount: number }[] }): number {
  return Math.round((c.payments ?? []).reduce((sum, p) => sum + p.amount, 0) * 100) / 100
}

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
  if (replies.some((r) => r.reply_class === 'declined')) return '他谢绝了 —— 跟进已经停了。'
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
  // WP299（决策 386 / 387）：寄样与付款那两块的输入
  const [sampleAddress, setSampleAddress] = useState('')
  const [sampleCarrier, setSampleCarrier] = useState('')
  const [sampleTracking, setSampleTracking] = useState('')
  const [sampleCost, setSampleCost] = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [payNote, setPayNote] = useState('')

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
    refreshCards(client)
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
          ? '验收结论提上去了，在卡片里等你批。批了才算数。'
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
          ? '议价提上去了，在卡片里等你批（那张卡上写着要付多少钱）。批了这条合作才进「谈条件中」。'
          : (out.message ?? '这个数没提上去。'),
      )
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这个数没提上去。'))
    },
  })

  const sample = useMutation({
    mutationFn: () =>
      shipKolSample(
        id,
        {
          address: sampleAddress.trim(),
          ...(sampleCarrier.trim() === '' ? {} : { carrier: sampleCarrier.trim() }),
          ...(sampleTracking.trim() === '' ? {} : { tracking_no: sampleTracking.trim() }),
          ...(Number(sampleCost) > 0 ? { cost: Number(sampleCost) } : {}),
        },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(
        out.applied === true
          ? '记下了：已寄样。'
          : out.staged
            ? '寄样提上去了，在卡片里等你批（卡上写着样品成本）。批了合作才进「已寄样」。'
            : (out.message ?? '这次寄样没记上。'),
      )
      if (out.applied === true || out.staged) {
        setSampleAddress('')
        setSampleCarrier('')
        setSampleTracking('')
        setSampleCost('')
      }
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这次寄样没记上。'))
    },
  })

  const pay = useMutation({
    mutationFn: () =>
      recordKolPayment(
        id,
        { amount: Number(payAmount), ...(payNote.trim() === '' ? {} : { note: payNote.trim() }) },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(
        out.staged
          ? '付款提上去了，在卡片里等你批。批了才记账。'
          : (out.message ?? '这笔付款没提上去。'),
      )
      if (out.staged) {
        setPayAmount('')
        setPayNote('')
      }
      refresh()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这笔付款没提上去。'))
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
            {t(`kol.channel.${collab.channel}`)}
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
        {/*
          WP141（docs/78 §2 红人第 27 步）：标题写「现在到哪一步」，下面原来只摆着
          **下一步**的按钮——于是「交付中」的合作这里读成「已交付」。现在先说现在在哪，
          再给「推到」哪几步。
        */}
        <section data-testid="kol-thread-stage">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            现在到哪一步：
            <span className="text-foreground" data-testid="kol-thread-stage-now">
              {t(`kol.stage.${collab.stage}`)}
            </span>
            {/* WP489：这一步是表格写的还是读邮件判的 */}
            {collab.stage_source === undefined ? null : (
              <span className="ml-1 text-muted-foreground" data-testid="kol-thread-stage-source">
                · {t(`kol.stage_source.${collab.stage_source}`)}
              </span>
            )}
          </h4>
          {/* WP489：邮件判阶段的依据（哪封、哪句） */}
          {(collab.stage_evidence ?? []).length === 0 ? null : (
            <ul className="mb-2 flex flex-col gap-0.5 text-xs" data-testid="kol-thread-evidence">
              {(collab.stage_evidence ?? []).map((e) => (
                <li key={e.message_id} className="text-muted-foreground">
                  {t('kol.mailstage.evidence')} · {e.at.slice(0, 10)} · {e.subject.slice(0, 40)}：
                  <span className="text-foreground">“{e.quote}”</span>
                </li>
              ))}
            </ul>
          )}
          {collab.import_note === undefined ? null : (
            <p
              className="mb-2 truncate text-xs text-muted-foreground"
              title={collab.import_note}
              data-testid="kol-thread-import-note"
            >
              {collab.import_note}
            </p>
          )}
          {/* WP302：步进条——走过哪几段、停在哪、停了几天（停满 7 天那一段标黄） */}
          {collab.segments === undefined ? null : (
            <CollabProgress
              segments={collab.segments}
              dwellDays={collab.dwell_days}
              layout="stepper"
              className="mb-2"
            />
          )}
          <div className="flex flex-wrap items-center gap-1">
            {(NEXT_STAGES[collab.stage] ?? []).length === 0 ? null : (
              <span className="text-xs text-muted-foreground">推到：</span>
            )}
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
            <p className="text-xs text-muted-foreground">
              还没有来往过。先去候选池给他起一封开发信。
            </p>
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
                    <span className="text-muted-foreground">
                      {x.at.slice(0, 16).replace('T', ' ')}
                    </span>
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
                    <p className="mt-0.5 text-xs text-muted-foreground">下一步：{klass.next}</p>
                  )}
                </li>
              )
            })}
          </ol>
          <p
            className="mt-1 rounded-[var(--ws-radius-card)] bg-muted px-2 py-1 text-xs text-muted-foreground"
            data-testid="kol-thread-cadence"
          >
            跟进节奏：{cadenceText(exchanges.data?.rows ?? [])}
          </p>
        </section>

        {/* ③ 议价：填一个数 → 一张 money 卡 → 批了才作数（WP295：只在谈之前 / 谈的时候出） */}
        {!QUOTE_STAGES.has(collab.stage) ? null : (
          <section data-testid="kol-thread-quote">
            <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Coins className="size-3" aria-hidden />
              议价
            </h4>
            {/* WP157：「永远要你点头 / AI 报不了价」是安全承诺，用盾牌那一行 */}
            <SafetyNote
              text={
                (exchanges.data?.rows ?? []).some((x) => x.reply_class === 'wants_quote')
                  ? '他问了价钱。填一个数，出一张卡；这一步永远要你自己点头。'
                  : '要谈钱就填一个数。合作的预算永远走卡，AI 报不了价。'
              }
            />
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
                disabled={
                  Number(budget) <= 0 || !Number.isFinite(Number(budget)) || quote.isPending
                }
                onClick={() => {
                  quote.mutate()
                }}
              >
                提一张议价卡
              </Button>
            </div>
          </section>
        )}

        {/*
          WP299（决策 386）：寄样。谈成之后才出；寄过的只留一行（快递、寄到哪儿、成本），
          没寄过的给一个小表——地址只进服务端加密库，回来的只有脱敏样子。
        */}
        {collab.sample === undefined && !SAMPLE_STAGES.has(collab.stage) ? null : (
          <section data-testid="kol-thread-sample">
            <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Truck className="size-3" aria-hidden />
              寄样
            </h4>
            {collab.sample === undefined ? null : (
              <p className="text-xs" data-testid="kol-thread-sample-line">
                {[
                  collab.sample.carrier,
                  collab.sample.tracking_no,
                  `寄到 ${collab.sample.address_masked}`,
                  collab.sample.cost === undefined
                    ? undefined
                    : `成本 ${collab.sample.cost} ${collab.sample.currency}`,
                ]
                  .filter((x): x is string => x !== undefined && x !== '')
                  .join(' · ')}
              </p>
            )}
            {collab.stage !== 'agreed' ? null : (
              <div className="mt-1 flex flex-col gap-2">
                <Textarea
                  value={sampleAddress}
                  rows={2}
                  placeholder="收件地址（只存在这台电脑的加密库里）"
                  aria-label="收件地址"
                  data-testid="kol-thread-sample-address"
                  onChange={(e) => {
                    setSampleAddress(e.target.value)
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-28"
                    value={sampleCarrier}
                    placeholder="快递"
                    aria-label="快递公司"
                    data-testid="kol-thread-sample-carrier"
                    onChange={(e) => {
                      setSampleCarrier(e.target.value)
                    }}
                  />
                  <Input
                    className="w-40"
                    value={sampleTracking}
                    placeholder="单号"
                    aria-label="快递单号"
                    data-testid="kol-thread-sample-tracking"
                    onChange={(e) => {
                      setSampleTracking(e.target.value)
                    }}
                  />
                  <Input
                    className="w-32"
                    value={sampleCost}
                    inputMode="decimal"
                    placeholder={`成本（${collab.currency}）`}
                    aria-label="样品成本"
                    data-testid="kol-thread-sample-cost"
                    onChange={(e) => {
                      setSampleCost(e.target.value)
                    }}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="kol-thread-sample-go"
                    disabled={sampleAddress.trim().length < 4 || sample.isPending}
                    onClick={() => {
                      sample.mutate()
                    }}
                  >
                    记下寄样
                  </Button>
                  <Hint
                    text="有成本会出一张卡等你批，批了才记账；没成本当场记下。"
                    testId="kol-thread-sample-hint"
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {/*
          WP299（决策 387）：付款。谈成之后才出；一笔一张「花钱」卡，批了才记账。
          上面一行是「已付 / 谈定」，超了卡上会说。
        */}
        {!PAYMENT_STAGES.has(collab.stage) ? null : (
          <section data-testid="kol-thread-payment">
            <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Wallet className="size-3" aria-hidden />
              付款
            </h4>
            {(collab.payments ?? []).length === 0 && collab.budget === undefined ? null : (
              <p className="text-xs" data-testid="kol-thread-paid">
                已付 {paidOf(collab)} {collab.currency}
                {collab.budget === undefined ? '' : ` · 谈定 ${collab.budget} ${collab.currency}`}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Input
                className="w-32"
                value={payAmount}
                inputMode="decimal"
                placeholder={`金额（${collab.currency}）`}
                aria-label="付款金额"
                data-testid="kol-thread-pay-amount"
                onChange={(e) => {
                  setPayAmount(e.target.value)
                }}
              />
              <Input
                className="min-w-32 flex-1"
                value={payNote}
                placeholder="备注（首款 / 尾款）"
                aria-label="付款备注"
                data-testid="kol-thread-pay-note"
                onChange={(e) => {
                  setPayNote(e.target.value)
                }}
              />
              <Button
                size="xs"
                variant="outline"
                data-testid="kol-thread-pay-go"
                disabled={!(Number(payAmount) > 0) || pay.isPending}
                onClick={() => {
                  pay.mutate()
                }}
              >
                提一张付款卡
              </Button>
            </div>
          </section>
        )}

        {/* ④ 交付物与验收（66 断点 #11：以前界面上没有这个入口）。WP295：谈成之后才出（已经登记过的照出） */}
        {!DELIVERY_STAGES.has(collab.stage) &&
        (deliverables.data?.rows ?? []).length === 0 ? null : (
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
        )}

        {/* ⑤ 追踪链接与它带来的数（归因）。WP295：谈条件起才出（谈成之后、寄样之前就该建好；建过的照出） */}
        {!LINK_STAGES.has(collab.stage) && (links.data?.rows ?? []).length === 0 ? null : (
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
        )}

        <KolError error={error} testid="kol-thread-error" />
        <KolReceipt text={receipt} testid="kol-thread-receipt" />
      </CardContent>
    </Card>
  )
}
