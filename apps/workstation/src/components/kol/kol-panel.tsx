/**
 * WP68（48 §5.1 / §5.4）：红人岗位页上那一块**能动手的**面板。
 *
 * WP67 之后红人那五块只能看（deck 的表格是只读投影）。这个组件补的是"动手"那一半：
 * 找人 → 点开详情 → 加联系方式 → 起开发信 → 推进阶段，外加导入与发起 campaign。
 *
 * 四条界面纪律：
 *
 * 1. **"拿不到"与"搜到 0 个"分得开**（36 §3）。搜索失败时出的是服务端那一句人话
 *    （没连 / 要审核 / 要申请 / 要买档 / 配额用完），不是一张空表。
 * 2. **联系方式永远只显示脱敏形态**。这个文件里没有一个地方拿得到明文——
 *    服务端的 `KolContactView` 上就没有那一格。
 * 3. **花钱之前先说数**。公共库那一档的 reveal 按钮上直接写着"扣 N 积分"，
 *    不是点完才知道。
 * 4. **灰着的东西要说得出为什么**。campaign 清单里本人没有那条职责的整组
 *    灰显 + 一句话，而不是悄悄少几行。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Coins, Mail, Megaphone, Search, Upload, Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  acceptKolCampaign,
  addKolContact,
  addKolCreator,
  advanceKolCollaboration,
  draftKolOutreach,
  getKolCollaborations,
  getKolCreator,
  getKolCreators,
  importKolTable,
  type KolCampaignData,
  type KolChannelId,
  type KolImportData,
  type KolOutreachData,
  type KolSearchData,
  planKolCampaign,
  revealKolContact,
  searchKolCreators,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { CollabThread } from './collab-thread'
import { KolSandboxBar } from './kol-sandbox-bar'
import { errorText, KolError, KolReceipt } from './kol-shared'

/** 五条渠道（真源是契约的 `KOL_CHANNEL_IDS`；工作台不依赖服务端包，这里照抄一份）。 */
const ALL_CHANNELS: readonly KolChannelId[] = ['youtube', 'facebook', 'instagram', 'tiktok', 'x']

/** 职责 id → 渠道（`kol.youtube` → `youtube`）。不是红人职责就回 `undefined`。 */
export function channelOfRole(role_id: string | undefined): KolChannelId | undefined {
  if (role_id === undefined || !role_id.startsWith('kol.')) return undefined
  const id = role_id.slice('kol.'.length)
  return ALL_CHANNELS.find((c) => c === id)
}

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

const num = (n: number | undefined): string =>
  n === undefined ? '—' : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n)

/* ── 找人 ─────────────────────────────────────────────────────────────── */

function Discovery({
  assignment,
  channel,
  onOpen,
}: {
  assignment: string
  channel: KolChannelId
  onOpen: (creator_id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<KolSearchData | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  const library = useQuery({
    queryKey: ['kol-creators', assignment, channel],
    queryFn: () => getKolCreators({ channel }, assignment),
  })

  const search = useMutation({
    mutationFn: () => searchKolCreators({ channel, q }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setFound(out)
    },
    // 66 断点：接口挂了要照实说，不许留在"搜索中"或者悄悄什么都不发生
    onError: (e: unknown) => {
      setError(errorText(e, '这次没搜成。'))
    },
  })

  const reveal = useMutation({
    mutationFn: (handle: string) => revealKolContact({ channel, handle }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(
        out.contact === undefined
          ? '这一次没取到联系方式（积分没扣）。'
          : `取到了：${out.contact.masked}，已经进你的库。`,
      )
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
      search.mutate()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这一次没取到（积分没扣）。'))
    },
  })

  const add = useMutation({
    mutationFn: (row: { display_name: string; handle: string; url: string }) =>
      addKolCreator({ ...row, channel }, assignment),
    onSuccess: (detail) => {
      setError(undefined)
      setReceipt(`${detail.creator.display_name} 进你的红人库了。`)
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
      search.mutate()
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这个人没加进库。'))
    },
  })

  return (
    <Card data-testid="kol-discovery">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Search className="size-4" aria-hidden />
          {t('kol.discovery.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={q}
            placeholder={t(`kol.search.placeholder.${channel}`)}
            data-testid="kol-search-input"
            onChange={(e) => {
              setQ(e.target.value)
            }}
            // 66 断点 #3：输关键词按回车没反应，非得去点「搜」
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || q.trim() === '' || search.isPending) return
              e.preventDefault()
              search.mutate()
            }}
          />
          <Button
            size="sm"
            data-testid="kol-search-go"
            disabled={q.trim() === '' || search.isPending}
            onClick={() => {
              search.mutate()
            }}
          >
            {t('kol.search.go')}
          </Button>
        </div>

        <KolError error={error} testid="kol-discovery-error" />
        <KolReceipt text={receipt} testid="kol-discovery-receipt" />

        {/*
          36 §3：**"拿不到"与"搜到 0 个"分得开**。服务端把没连 / 要审核 / 要申请 /
          要买档 / 配额用完各说成一句人话，界面照它说，不画一张空表。
        */}
        {found !== undefined && !found.ok ? (
          <p className="text-sm text-muted-foreground" data-testid="kol-search-blocked">
            {found.message}
          </p>
        ) : null}

        {found?.ok === true ? (
          <div className="flex flex-col gap-2" data-testid="kol-search-results">
            <p className="text-xs text-muted-foreground">
              {t(`kol.source.${found.source}`)}
              {found.reveal_price === undefined ? '' : ` · ${found.reveal_price.note}`}
            </p>
            {found.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('kol.search.none')}</p>
            ) : null}
            {found.rows.map((row) => (
              <div
                key={`${row.channel}:${row.handle}`}
                className="flex items-center justify-between gap-2 border-b pb-2 text-sm"
                data-testid="kol-search-row"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{row.display_name}</div>
                  <div className="text-xs text-muted-foreground">
                    @{row.handle} · {t('kol.followers', { n: num(row.followers) })}
                    {row.in_library === true ? ` · ${t('kol.in_library')}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {found.source === 'public_library' && row.has_contact === true ? (
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="kol-reveal"
                      disabled={reveal.isPending}
                      onClick={() => {
                        reveal.mutate(row.handle)
                      }}
                    >
                      <Coins className="size-3" aria-hidden />
                      {t('kol.reveal', { n: found.reveal_price?.credits ?? 0 })}
                    </Button>
                  ) : null}
                  {row.in_library === true ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      data-testid="kol-add"
                      disabled={add.isPending}
                      onClick={() => {
                        add.mutate({
                          display_name: row.display_name,
                          handle: row.handle,
                          url: row.url,
                        })
                      }}
                    >
                      {t('kol.add')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="mt-1">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('kol.library')}</h4>
          {library.isPending ? <Skeleton className="h-16 w-full" /> : null}
          {/*
            36 §3 的同一条规矩，**查询这一侧**：取不回来不等于库里没人。
            这一条是拍演练截图时撞出来的——demo 的请求配额用完回了 429，
            界面上显示的却是"库里还没有人。先导一张表进来"，
            于是人会去导一张他早就导过的表。
          */}
          {library.error !== null ? (
            <KolError
              error={errorText(library.error, '红人库这次没取回来。')}
              testid="kol-library-error"
            />
          ) : null}
          {library.error === null &&
          (library.data?.rows ?? []).length === 0 &&
          !library.isPending ? (
            <p className="text-sm text-muted-foreground" data-testid="kol-library-empty">
              {t('kol.library.empty')}
            </p>
          ) : null}
          <ol className="flex flex-col gap-1" data-testid="kol-library">
            {(library.data?.rows ?? []).map((row) => (
              <li key={row.creator_id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-sm hover:bg-muted"
                  data-testid="kol-library-row"
                  data-creator={row.creator_id}
                  onClick={() => {
                    onOpen(row.creator_id)
                  }}
                >
                  <span className="min-w-0 truncate">
                    {row.display_name}
                    <span className="text-xs text-muted-foreground"> @{row.handle}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {/* 刷粉护栏那一条：清单上看得见"这个数不可信"，不悄悄少一行 */}
                    {row.blocked === undefined ? (
                      <span>{t('kol.score', { n: row.score })}</span>
                    ) : (
                      <span className="text-destructive" data-testid="kol-blocked">
                        {row.blocked}
                      </span>
                    )}
                    <ChevronRight className="size-3" aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}

/* ── 红人详情（资料快照 / 联系方式脱敏 / 合作历史）───────────────────── */

function CreatorDetail({
  assignment,
  channel,
  id,
  onClose,
}: {
  assignment: string
  channel: KolChannelId
  id: string
  onClose: () => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [product, setProduct] = useState('')
  /*
   * "我们是做什么的"这句话**只有用户自己知道**，服务端不编一个（编出来最好也是废话）。
   * 所以这里是一个真的输入框，而不是一个可以省略的参数。
   */
  const [pitch, setPitch] = useState('')
  const [draft, setDraft] = useState<KolOutreachData | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  const detail = useQuery({
    queryKey: ['kol-creator', id],
    queryFn: () => getKolCreator(id, assignment),
  })

  /*
   * 66 断点 #6：这一跳以前 400 了界面什么都不显示，邮箱还留在框里像是成功了。
   * 现在两件事都做对：成功才清空输入框，失败照实说服务端那句话
   * （「这台机器的加密库没开」这种，用户看得懂该去干什么）。
   */
  const addContact = useMutation({
    mutationFn: () => addKolContact(id, { kind: 'email', value: email }, assignment),
    onSuccess: (contact) => {
      setError(undefined)
      setReceipt(`加好了：${contact.masked}。现在可以起开发信了。`)
      setEmail('')
      void client.invalidateQueries({ queryKey: ['kol-creator', id] })
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这条联系方式没加上。'))
    },
  })

  /*
   * 66 断点 #7：接口回了 201，界面却显示失败——因为这里只认 `draft.staged`，
   * 而真正的失败（异常）根本没人接。现在分成三种：成功出卡、被拦下
   * （`staged: false` + 一句人话）、这一跳没打通（异常）。
   */
  const outreach = useMutation({
    mutationFn: () =>
      draftKolOutreach({ creator_id: id, channel, product, brand_pitch: pitch }, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setDraft(out)
      setReceipt(
        out.staged
          ? out.auto_approved === true
            ? '这封信已经排进出站队列。'
            : '起草好了，在待办里等你批。批了才发。'
          : undefined,
      )
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      void client.invalidateQueries({ queryKey: ['cards'] })
    },
    onError: (e: unknown) => {
      setDraft(undefined)
      setReceipt(undefined)
      setError(errorText(e, '这封信没起草成。'))
    },
  })

  if (detail.isPending) return <Skeleton className="h-48 w-full" />
  const view = detail.data
  if (view === undefined) return null

  return (
    <Card data-testid="kol-creator-detail" data-creator={id}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">{view.creator.display_name}</CardTitle>
        <Button size="xs" variant="ghost" data-testid="kol-detail-close" onClick={onClose}>
          {t('kol.detail.close')}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {/* ① 资料快照：`observed_at` 一定露在外面——半年前的粉丝数拿来打分，与编一个数没区别 */}
        <section data-testid="kol-accounts">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('kol.detail.profile')}
          </h4>
          {view.accounts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <a className="underline" href={a.url} target="_blank" rel="noreferrer">
                @{a.handle}
              </a>
              <span className="text-xs text-muted-foreground">
                {t(`kol.channel.${a.channel}`)} · {t('kol.followers', { n: num(a.followers) })} ·
                {t('kol.engagement', {
                  n:
                    a.engagement_rate === undefined
                      ? '—'
                      : `${(a.engagement_rate * 100).toFixed(1)}%`,
                })}
              </span>
              <span className="text-xs text-muted-foreground" data-testid="kol-observed-at">
                {t('kol.observed_at', { at: a.observed_at.slice(0, 10) })}
              </span>
            </div>
          ))}
        </section>

        {/* ② 联系方式：**只有脱敏形态**（这个组件里拿不到明文，服务端也不给） */}
        <section data-testid="kol-contacts">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('kol.detail.contacts')}
          </h4>
          {view.contacts.length === 0 ? (
            <p className="text-muted-foreground">{t('kol.detail.contacts.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {view.contacts.map((c) => (
                <li key={c.id} className="font-mono text-xs" data-testid="kol-contact">
                  {c.masked}
                  <span className="ml-2 font-sans text-muted-foreground">
                    {t(`kol.contact.source.${c.source}`, { source: c.source })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{t('kol.detail.contacts.note')}</p>
          <KolError error={error} testid="kol-detail-error" />
          <KolReceipt text={receipt} testid="kol-detail-receipt" />
          <div className="mt-1 flex items-center gap-2">
            <Input
              value={email}
              placeholder="name@example.com"
              data-testid="kol-contact-input"
              onChange={(e) => {
                setEmail(e.target.value)
              }}
            />
            <Button
              size="xs"
              variant="outline"
              data-testid="kol-contact-save"
              disabled={email.trim() === '' || addContact.isPending}
              onClick={() => {
                addContact.mutate()
              }}
            >
              {t('kol.detail.contacts.add')}
            </Button>
          </div>
        </section>

        {/* ③ 建联：开发信草稿卡 */}
        <section data-testid="kol-outreach">
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Mail className="size-3" aria-hidden />
            {t('kol.detail.outreach')}
          </h4>
          <div className="flex flex-col gap-1">
            <Input
              value={pitch}
              placeholder={t('kol.detail.outreach.pitch')}
              data-testid="kol-outreach-pitch"
              onChange={(e) => {
                setPitch(e.target.value)
              }}
            />
            <div className="flex items-center gap-2">
              <Input
                value={product}
                placeholder={t('kol.detail.outreach.product')}
                data-testid="kol-outreach-product"
                onChange={(e) => {
                  setProduct(e.target.value)
                }}
              />
              <Button
                size="xs"
                data-testid="kol-outreach-go"
                disabled={product.trim() === '' || pitch.trim() === '' || outreach.isPending}
                onClick={() => {
                  outreach.mutate()
                }}
              >
                {t('kol.detail.outreach.draft')}
              </Button>
            </div>
          </div>
          {draft === undefined ? null : (
            <div className="mt-2 rounded border p-2" data-testid="kol-outreach-draft">
              {draft.staged ? (
                <>
                  <div className="text-xs font-medium">{draft.subject}</div>
                  <Textarea className="mt-1 text-xs" readOnly rows={6} value={draft.body} />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {draft.auto_approved === true
                      ? t('kol.detail.outreach.auto')
                      : t('kol.detail.outreach.queued')}
                    {' · '}
                    {t('kol.detail.outreach.quota', {
                      n: draft.quota.remaining,
                      cap: draft.quota.cap,
                    })}
                  </p>
                </>
              ) : (
                // 禁承诺是 block 不是转人审：这一封根本没进队列，理由照实说
                <p className="text-xs text-destructive" data-testid="kol-outreach-blocked">
                  {draft.message}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ④ 合作历史 */}
        <section data-testid="kol-history">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('kol.detail.history')}
          </h4>
          {view.collaborations.length === 0 ? (
            <p className="text-muted-foreground">{t('kol.detail.history.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-xs">
              {view.collaborations.map((c) => (
                <li key={c.id}>
                  {t(`kol.channel.${c.channel}`)} · {t(`kol.stage.${c.stage}`)}
                  {c.budget === undefined ? '' : ` · ${c.budget} ${c.currency}`}
                </li>
              ))}
            </ul>
          )}
          {view.deliverables.length === 0 ? null : (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              {view.deliverables.map((d) => (
                <li key={d.id}>
                  {d.kind} · {t(`kol.review.${d.review}`)} · {d.due_at.slice(0, 10)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

/* ── 合作：阶段推进 ───────────────────────────────────────────────────── */

function Collaborations({
  assignment,
  channel,
  onOpen,
}: {
  assignment: string
  channel: KolChannelId
  onOpen: (collaboration_id: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [error, setError] = useState<string | undefined>(undefined)

  const list = useQuery({
    queryKey: ['kol-collaborations', assignment, channel],
    queryFn: () => getKolCollaborations({ channel }, assignment),
  })

  const advance = useMutation({
    mutationFn: (input: { id: string; stage: string }) =>
      advanceKolCollaboration(input.id, input.stage, assignment),
    onSuccess: () => {
      setError(undefined)
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      void client.invalidateQueries({ queryKey: ['kol-creator'] })
    },
    // 非法跳转回的是一句人话（"还没建联就说交付完了"），照实显示
    onError: (e: Error) => {
      setError(e.message)
    },
  })

  const rows = (list.data?.rows ?? []).filter((c) => c.stage !== 'closed')
  return (
    <Card data-testid="kol-collaborations">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Users className="size-4" aria-hidden />
          {t('kol.collab.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {list.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {/* 同上：取不回来不等于"没有在谈的合作" */}
        {list.error !== null ? (
          <KolError
            error={errorText(list.error, '合作清单这次没取回来。')}
            testid="kol-collab-list-error"
          />
        ) : null}
        {list.error === null && rows.length === 0 && !list.isPending ? (
          <p className="text-muted-foreground">{t('kol.collab.empty')}</p>
        ) : null}
        {rows.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
            data-testid="kol-collab-row"
            data-stage={c.stage}
          >
            <button
              type="button"
              className="rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
              data-testid="kol-collab-open"
              data-collab={c.id}
              onClick={() => {
                onOpen(c.id)
              }}
            >
              {t(`kol.stage.${c.stage}`)}
              {c.budget === undefined ? '' : ` · ${c.budget} ${c.currency}`}
              <ChevronRight className="ml-1 inline size-3" aria-hidden />
            </button>
            <span className="flex gap-1">
              {(NEXT_STAGES[c.stage] ?? []).map((next) => (
                <Button
                  key={next}
                  size="xs"
                  variant="outline"
                  data-testid="kol-stage-next"
                  data-next={next}
                  disabled={advance.isPending}
                  onClick={() => {
                    advance.mutate({ id: c.id, stage: next })
                  }}
                >
                  {t(`kol.stage.${next}`)}
                </Button>
              ))}
            </span>
          </div>
        ))}
        {error === undefined ? null : (
          <p className="text-xs text-destructive" data-testid="kol-stage-error">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/* ── 导入与 campaign ──────────────────────────────────────────────────── */

function ImportAndCampaign({
  assignment,
  channel,
}: {
  assignment: string
  channel: KolChannelId
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState<KolImportData | undefined>(undefined)
  const [plan, setPlan] = useState<KolCampaignData | undefined>(undefined)
  const [goal, setGoal] = useState('')
  const [budget, setBudget] = useState('1000')
  const [headcount, setHeadcount] = useState('5')
  /*
   * 一次 campaign **可以跨渠道**（48 §5.2）——所以这里是一排勾，不是只有当前这条。
   * 勾上一条本人没有职责的渠道，清单照样把人挑出来给他看，只是那一组灰着、
   * 点不动（05 §4「不做跨 Assignment 并集」）。看得见比悄悄少几行有用得多。
   */
  const [channels, setChannels] = useState<KolChannelId[]>([channel])
  const [error, setError] = useState<string | undefined>(undefined)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)

  const doImport = useMutation({
    mutationFn: (input: { filename: string; content: string }) => importKolTable(input, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setImported(out)
      void client.invalidateQueries({ queryKey: ['kol-creators'] })
    },
    onError: (e: unknown) => {
      setImported(undefined)
      setError(errorText(e, '这张表没导进来。'))
    },
  })

  const doPlan = useMutation({
    mutationFn: () =>
      planKolCampaign(
        {
          goal,
          budget: Number(budget),
          channels,
          headcount: Number(headcount),
        },
        assignment,
      ),
    onSuccess: (out) => {
      setError(undefined)
      setReceipt(undefined)
      setPlan(out)
    },
    onError: (e: unknown) => {
      setPlan(undefined)
      setError(errorText(e, '这份清单没出来。'))
    },
  })

  /*
   * 66 断点 #5：接口回 200，清单直接消失，**没有任何回执**——人不知道
   * "接受"之后发生了什么，也不知道下一步该去哪儿看。清单还是要收起来
   * （它已经被采纳了，留着会让人以为还能再点一次），但必须换成一句话：
   * 建了几条、去哪儿看。
   */
  const doAccept = useMutation({
    mutationFn: (id: string) => acceptKolCampaign(id, assignment),
    onSuccess: (out) => {
      setError(undefined)
      setPlan(undefined)
      const created = out.created.length
      const skipped = out.skipped.length
      setReceipt(
        created === 0
          ? `一条都没新建（跳过 ${skipped} 条：${out.skipped[0]?.reason ?? '库里已经有了'}）。`
          : `建了 ${created} 条合作，都在「合作线程」那一页里${skipped === 0 ? '' : `（跳过 ${skipped} 条）`}。`,
      )
      void client.invalidateQueries({ queryKey: ['kol-collaborations'] })
      void client.invalidateQueries({ queryKey: ['cards'] })
    },
    onError: (e: unknown) => {
      setReceipt(undefined)
      setError(errorText(e, '这份清单没接受成，一条合作都没建。'))
    },
  })

  return (
    <Card data-testid="kol-tools">
      <CardHeader>
        <CardTitle className="text-sm">{t('kol.tools.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <section>
          {/*
            导入这一版只认 CSV / TSV（仓库的 pnpm 里没有 xlsx 依赖）。
            `accept` 里不写 .xlsx——挑得到却传不进去比挑不到更气人；
            服务端收到 .xlsx 也会照实说一句"另存为 CSV 再传一次"。
          */}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
            className="hidden"
            data-testid="kol-import-file"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file === undefined) return
              void file.text().then((content) => {
                doImport.mutate({ filename: file.name, content })
              })
            }}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="kol-import"
            disabled={doImport.isPending}
            onClick={() => {
              fileRef.current?.click()
            }}
          >
            <Upload className="size-4" aria-hidden />
            {t('kol.import')}
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">{t('kol.import.hint')}</p>
          {imported === undefined ? null : (
            <div className="mt-1 text-xs" data-testid="kol-import-result">
              <p>{imported.summary}</p>
              {imported.note === undefined ? null : (
                <p className="text-muted-foreground" data-testid="kol-import-note">
                  {imported.note}
                </p>
              )}
              {imported.rejected.slice(0, 3).map((r) => (
                <p key={r.source_row} className="text-muted-foreground">
                  {t('kol.import.rejected', { row: r.source_row, reason: r.reason })}
                </p>
              ))}
            </div>
          )}
        </section>

        <section data-testid="kol-campaign">
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">
            {t('kol.campaign.title')}
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-40 flex-1"
              value={goal}
              placeholder={t('kol.campaign.goal')}
              data-testid="kol-campaign-goal"
              onChange={(e) => {
                setGoal(e.target.value)
              }}
            />
            <Input
              className="w-24"
              value={budget}
              inputMode="numeric"
              aria-label={t('kol.campaign.budget')}
              data-testid="kol-campaign-budget"
              onChange={(e) => {
                setBudget(e.target.value)
              }}
            />
            <Input
              className="w-20"
              value={headcount}
              inputMode="numeric"
              aria-label={t('kol.campaign.headcount')}
              data-testid="kol-campaign-headcount"
              onChange={(e) => {
                setHeadcount(e.target.value)
              }}
            />
            <Button
              size="sm"
              data-testid="kol-campaign-go"
              disabled={goal.trim() === '' || channels.length === 0 || doPlan.isPending}
              onClick={() => {
                doPlan.mutate()
              }}
            >
              {t('kol.campaign.plan')}
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {ALL_CHANNELS.map((c) => (
              <Button
                key={c}
                size="xs"
                variant={channels.includes(c) ? 'secondary' : 'ghost'}
                aria-pressed={channels.includes(c)}
                data-testid="kol-campaign-channel"
                data-channel={c}
                onClick={() => {
                  setChannels((prev) =>
                    prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
                  )
                }}
              >
                {t(`kol.channel.${c}`)}
              </Button>
            ))}
          </div>
          <KolError error={error} testid="kol-campaign-error" />
          <KolReceipt text={receipt} testid="kol-campaign-receipt" />
          {plan === undefined ? null : (
            <div className="mt-2 flex flex-col gap-2" data-testid="kol-campaign-plan">
              {plan.ready ? null : <p className="text-xs text-destructive">{plan.message}</p>}
              {plan.by_channel.map((group) => (
                <div
                  key={group.channel}
                  className={group.allowed ? '' : 'opacity-50'}
                  data-testid="kol-campaign-group"
                  data-channel={group.channel}
                  data-allowed={String(group.allowed)}
                >
                  <div className="text-xs font-medium">
                    {t(`kol.channel.${group.channel}`)} · {group.picks.length}
                  </div>
                  {/* 灰着的东西要说得出为什么（05 §4：一次 campaign 不并集权限） */}
                  {group.reason === undefined ? null : (
                    <p className="text-[11px] text-muted-foreground" data-testid="kol-campaign-why">
                      {group.reason}
                    </p>
                  )}
                  <ul className="text-xs text-muted-foreground">
                    {group.picks.map((p) => (
                      <li key={p.creator_id}>
                        {p.display_name} · {t('kol.score', { n: p.score })}
                        {p.why[0] === undefined ? '' : ` · ${p.why[0]}`}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {plan.approval_item_id === undefined ? null : (
                <div>
                  <Button
                    size="sm"
                    data-testid="kol-campaign-accept"
                    disabled={doAccept.isPending}
                    onClick={() => {
                      doAccept.mutate(plan.approval_item_id as string)
                    }}
                  >
                    {t('kol.campaign.accept')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  )
}

/* ── 岗位页上那一块：三个子视图 ───────────────────────────────────────── */

/**
 * 66 断点 #10：以前导入、campaign、找人、合作、红人库、漏斗、交付物、归因
 * **全挤在「面板」tab 的一长条里**，没有"一件事的界面"这种东西。
 *
 * 现在切成三个子视图，切分的依据是**红人营销干活时脑子里的三个阶段**，
 * 不是接口的分组：
 *
 * | 视图 | 这一阶段在想什么 |
 * |---|---|
 * | 候选池 | 还没定人：找、导、看资料、加联系方式、起第一封信 |
 * | 活动 | 定了一批人：出清单、接受、按渠道分组 |
 * | 合作线程 | 定了一个人：这条合作到哪一步了，交付物验没验，链接带来多少单 |
 *
 * 为什么是岗位页里的子视图而不是三条路由：这三样都只对"当前这条渠道职责"
 * 有意义，离开这个岗位它们没有独立存在的理由（对照 `/chat` 那条真路由——
 * 在线聊天试用场确实是一件独立的事）。子视图的状态跟着 `?kol=` 走，
 * 与岗位页 `?tab=` 同一套，刷新与分享链接都还在原地。
 */
const SUBVIEWS = [
  { id: 'pool', zh: '候选池', icon: Search },
  { id: 'campaign', zh: '活动', icon: Megaphone },
  { id: 'threads', zh: '合作线程', icon: Users },
] as const

type SubviewId = (typeof SUBVIEWS)[number]['id']

export function KolPanel({
  assignment,
  channel,
}: {
  assignment: string
  channel: KolChannelId
}): React.ReactNode {
  const [search, setSearch] = useSearchParams()
  const raw = search.get('kol') ?? 'pool'
  const view: SubviewId = SUBVIEWS.some((v) => v.id === raw) ? (raw as SubviewId) : 'pool'
  /** 点开的那一个人（候选池里）。 */
  const [openCreator, setOpenCreator] = useState<string | undefined>(undefined)
  /** 点开的那一条合作（合作线程里）。 */
  const [openCollab, setOpenCollab] = useState<string | undefined>(undefined)

  const go = (next: SubviewId): void => {
    setSearch((prev) => {
      const params = new URLSearchParams(prev)
      params.set('kol', next)
      return params
    })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="kol-panel" data-channel={channel}>
      {/* 演练开关 + 状态带：三个视图共用一条，永远在最上面 */}
      <KolSandboxBar assignment={assignment} channel={channel} />

      <nav className="flex flex-wrap items-center gap-1" data-testid="kol-subviews">
        {SUBVIEWS.map((v) => (
          <Button
            key={v.id}
            size="sm"
            variant={v.id === view ? 'secondary' : 'ghost'}
            aria-pressed={v.id === view}
            data-testid="kol-subview"
            data-view={v.id}
            onClick={() => {
              go(v.id)
            }}
          >
            <v.icon className="size-4" aria-hidden />
            {v.zh}
          </Button>
        ))}
      </nav>

      {view === 'pool' ? (
        <>
          <Discovery assignment={assignment} channel={channel} onOpen={setOpenCreator} />
          {openCreator === undefined ? null : (
            <CreatorDetail
              assignment={assignment}
              channel={channel}
              id={openCreator}
              onClose={() => {
                setOpenCreator(undefined)
              }}
            />
          )}
        </>
      ) : null}

      {view === 'campaign' ? <ImportAndCampaign assignment={assignment} channel={channel} /> : null}

      {view === 'threads' ? (
        openCollab === undefined ? (
          <Collaborations assignment={assignment} channel={channel} onOpen={setOpenCollab} />
        ) : (
          <CollabThread
            assignment={assignment}
            channel={channel}
            id={openCollab}
            onBack={() => {
              setOpenCollab(undefined)
            }}
          />
        )
      ) : null}
    </div>
  )
}
