/**
 * 连接页的「添加连接」（54（将改号 55）§4 第一层，WP83）。
 *
 * 为什么不是把整张表铺在首屏（54 §4「会大，但只在设置页与搜索里出现」）：
 * 目录二十多条，多数人一辈子只连三四个。铺开 = 每次进连接页都要从二十条里
 * 找那一条已经连好的邮箱。所以：
 *
 * - 默认**收起来**，一个按钮；
 * - 打开之后先给**搜索框**，再按分类分组；
 * - 已连的那几条在上面的"已连接"里，这里只标一个小圆点，不重复画一遍卡。
 *
 * 36 §2：这一屏里不出现任何原始店铺 id / 账号 id——目录说的是"哪一类东西"。
 * 13 §4.3：凭据一概不在这里填。点"去连接"跳到那张 provider 卡上的**原生表单**去；
 * 只有自定义 MCP 服务器的表单在这里，而它也是原生 `<form>` + `FormData`（见下）。
 *
 * WP456-T6（WP456 §3.8「『添加连接』『可以连接』说的是同一件事」）：设置 → 账号连接里不再单独一节、
 * 不再有自己的标题和「看全部」按钮——连接页顶上那一个搜索框、底下那一行「看全部 N 个」管着它
 * （`embedded`）：只列**连接页那张列表里没有的**几条（还没做的、去别的页接的、自定义 MCP），
 * 按分类分组、每组一张列表组。单独用（没给 `embedded`）时还是原来那样：默认收起、自带搜索。
 */
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, CircleDashed, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CategoryTag, GroupLabel, ListGroup } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { type ConnectionDirectoryItem, getConnectionDirectory } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { McpServers } from './mcp-servers'

/** 分类的出场顺序（与契约的 `CONNECTION_CATEGORIES` 同一份顺序）。 */
const CATEGORY_ORDER = [
  'storefront',
  'mailbox',
  'marketplace',
  'analytics',
  'ads',
  'social',
  'marketing',
  'logistics',
  'payment',
  'reviews',
  'im',
  'dev',
  'custom',
] as const

function StateDot({ state }: { state: ConnectionDirectoryItem['state'] }): React.ReactNode {
  const { t } = useApp()
  if (state === 'connected')
    return (
      <CircleCheck className="size-4 text-primary" aria-label={t('connections.state.connected')} />
    )
  if (state === 'error')
    return (
      <CircleAlert className="size-4 text-destructive" aria-label={t('connections.state.error')} />
    )
  return (
    <CircleDashed
      className="size-4 text-muted-foreground"
      aria-label={t('connections.state.not_connected')}
    />
  )
}

export function matches(entry: ConnectionDirectoryItem, q: string): boolean {
  if (q === '') return true
  const needle = q.trim().toLowerCase()
  return (
    entry.name.zh.toLowerCase().includes(needle) ||
    entry.name.en.toLowerCase().includes(needle) ||
    entry.kind.includes(needle)
  )
}

/**
 * WP456-T6：连接页的列表里已经有这一条了（它背后那张 provider 卡就在列表里）——目录里不再重复列。
 */
export function inCatalog(entry: ConnectionDirectoryItem, services: ReadonlySet<string>): boolean {
  const service = entry.connect_service ?? entry.service
  return service !== undefined && services.has(service)
}

function EntryRow({ entry }: { entry: ConnectionDirectoryItem }): React.ReactNode {
  const { t, lang } = useApp()
  const name = lang === 'zh' ? entry.name.zh : entry.name.en
  const note = entry.note === undefined ? undefined : lang === 'zh' ? entry.note.zh : entry.note.en
  const external = entry.docs_url !== undefined && entry.docs_url.startsWith('/')
  return (
    <li
      className="ws-row flex-wrap justify-between"
      data-testid="directory-entry"
      data-kind={entry.kind}
      data-state={entry.state}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5">
          <StateDot state={entry.state} />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-ws-ui">
            {name}
            {/* WP157（36 §7）：每条的说明进问号，目录一行只留名字、状态与动作 */}
            {note === undefined ? null : <Hint text={note} testId="directory-note" />}
            {entry.status === 'planned' ? (
              <CategoryTag outline data-testid="directory-planned">
                {t('connections.directory.planned')}
              </CategoryTag>
            ) : null}
            {/* 54 §3 的读写分类：能改外面的东西要让人一眼看见 */}
            {entry.side_effect === 'write_external' ? (
              <span className="text-xs text-ws-muted-fg">{t('connections.directory.writes')}</span>
            ) : null}
          </p>
          {entry.state_detail === undefined ? null : (
            <p className="text-xs text-destructive" data-testid="directory-state-detail">
              {entry.state_detail}
            </p>
          )}
        </div>
      </div>
      {entry.status === 'available' && entry.connect_service !== undefined ? (
        <Button asChild size="sm" variant="secondary">
          <Link
            to={`/connections?service=${encodeURIComponent(entry.connect_service)}`}
            data-testid="directory-go"
          >
            {entry.state === 'connected'
              ? t('connections.directory.manage')
              : t('connections.directory.connect')}
          </Link>
        </Button>
      ) : external ? (
        // WP85 的渠道页；那一页做出来之前点过去是一页"还没做"，比一个点不动的按钮诚实
        <Button asChild size="sm" variant="ghost">
          <Link to={entry.docs_url ?? '/'} data-testid="directory-route">
            {t('connections.directory.learn')}
          </Link>
        </Button>
      ) : (
        <span className="text-xs text-ws-muted-fg">{t('connections.directory.later')}</span>
      )}
    </li>
  )
}

export function ConnectionDirectorySection({
  assignment,
  embedded,
}: {
  assignment?: string
  /**
   * WP456-T6：嵌在连接页的列表下面——搜索词由连接页那一个搜索框给，`catalog` 里的（列表里已有的）不重复列，
   * 不画标题和「看全部」按钮。一条都不剩时整块不画。
   */
  embedded?: { query: string; catalog: ReadonlySet<string> }
}): React.ReactNode {
  const { t } = useApp()
  const [openSelf, setOpen] = useState(false)
  const [qSelf, setQ] = useState('')
  const open = embedded !== undefined || openSelf
  const q = embedded?.query ?? qSelf
  const directory = useQuery({
    queryKey: ['connection-directory', assignment],
    // 收起来的时候不查：目录是一张静态表，没人打开就没必要拉
    enabled: open,
    queryFn: () => getConnectionDirectory(assignment),
  })

  if (embedded !== undefined) {
    const extra = (directory.data?.entries ?? []).filter(
      (e) => !inCatalog(e, embedded.catalog) && matches(e, q),
    )
    if (extra.length === 0) return null
    return (
      <section className="flex flex-col gap-4" data-testid="connection-directory">
        {CATEGORY_ORDER.map((category) => {
          const rows = extra.filter((e) => e.category === category)
          if (rows.length === 0) return null
          return (
            <section
              key={category}
              className="flex flex-col gap-2"
              data-testid="directory-category"
              data-category={category}
            >
              <GroupLabel>{t(`connections.category.${category}`)}</GroupLabel>
              <ListGroup as="ul">
                {rows.map((entry) => (
                  <EntryRow key={entry.kind} entry={entry} />
                ))}
              </ListGroup>
              {category === 'custom' ? (
                <McpServers {...(assignment === undefined ? {} : { assignment })} />
              ) : null}
            </section>
          )
        })}
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-2" data-testid="connection-directory">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          {t('connections.directory.title')}
          <Hint text={t('connections.directory.hint')} />
        </h3>
        <Button
          size="sm"
          variant={open ? 'ghost' : 'secondary'}
          data-testid="directory-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {open ? (
            t('connections.directory.close')
          ) : (
            <>
              <Plus className="size-4" aria-hidden />
              {t('connections.directory.open')}
            </>
          )}
        </Button>
      </div>
      {!open ? (
        <p className="text-sm text-muted-foreground">{t('connections.directory.subtitle')}</p>
      ) : directory.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <Input
              value={q}
              data-testid="directory-search"
              aria-label={t('connections.directory.search')}
              placeholder={t('connections.directory.search')}
              onChange={(e) => {
                setQ(e.target.value)
              }}
            />
          </div>
          {CATEGORY_ORDER.map((category) => {
            const rows = (directory.data?.entries ?? []).filter(
              (e) => e.category === category && matches(e, q),
            )
            if (rows.length === 0) return null
            return (
              <section key={category} data-testid="directory-category" data-category={category}>
                <GroupLabel className="mb-2">{t(`connections.category.${category}`)}</GroupLabel>
                <ListGroup as="ul">
                  {rows.map((entry) => (
                    <EntryRow key={entry.kind} entry={entry} />
                  ))}
                </ListGroup>
                {/* 自定义 MCP 服务器那一条点开就是它自己的表单，不跳别处 */}
                {category === 'custom' ? (
                  <McpServers {...(assignment === undefined ? {} : { assignment })} />
                ) : null}
              </section>
            )
          })}
          {(directory.data?.entries ?? []).filter((e) => matches(e, q)).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="directory-empty">
              {t('connections.directory.no_match')}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
