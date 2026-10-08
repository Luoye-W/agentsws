/**
 * 36 §3 第三个对话入口：⌘K 命令面板——**搜索、跳转、加一个数字块**。
 *
 * 它不是聊天框：每一项都是一个确定的动作（跳到某张卡 / 某个岗位，或往首页加一个数字块），
 * 没有自由文本会被送去问模型。工作台**没有全局聊天框**（36 §3 A4）。
 *
 * WP70（54 §4）：**岗位名排在前**；职责名也搜得到，但结果显示成「岗位 › 职责」——
 * 搜"邮件营销"跳的还是网站运营那一页，只是这一行告诉你它归在哪个岗位下。
 * 没装岗位面的服务进程退回按分配列（老样子）。
 *
 * WP157：**教程也搜得到**（「教程」一组）——搜"百炼""浏览器插件"，回车在右栏打开那一篇
 * （与卡片上的「看教程」同一条路：`openAddress('agentsws://help/<slug>')`）。
 * 中英两种标题都进搜索词，界面是英文也能用中文名搜到。
 *
 * WP207 三处：
 * - **对话与任务也搜得到**（标题、摘要、正文，服务端全文搜），归档的标「已归档」；
 * - 最后一项「让 AI 找回『…』」：拿这句模糊的话去找归档的，给几张候选卡，**点一张才放回来**；
 * - 左栏职责行的「+」打开的是「写一句话」这一格（岗位与职责已经选好），回车就交出去。
 *   这三处都是确定的动作——⌘K 仍然不是聊天框。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useBrands } from '@/components/brand-switcher'
import type { ComposeTarget, Handoff } from '@/components/palette-context'
import { useRailState } from '@/components/rail/rail-state'
import { DutyIcon, PositionIcon } from '@/components/role-icons/role-icon'
import { RecallCards } from '@/components/sidebar/recall-cards'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { HandoffError } from '@/components/work/handoff-error'
import {
  enterSwitchedBrand,
  listCatalog,
  openMatterAtPosition,
  type PositionInstanceData,
  type PositionSummary,
  switchBrand,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { handoffInput, TASK_TEXT_MAX } from '@/lib/handoff'
import { HELP_SLUGS, helpAddress } from '@/lib/help'
import { translate } from '@/lib/i18n'
import { useMode } from '@/lib/mode'
import { myAssignments } from '@/lib/positions'
import { findArchivedWork, RAIL_KEY, searchWork } from '@/lib/work-archive'

/** WP213：⌘K 里高亮的那一项，岗位 / 职责图标的点睛那一笔换品牌色（docs/36 §8.3）。 */
const SELECTED_ACCENT = 'data-[selected=true]:[--ia:var(--ws-brand)]'

export function CommandPalette({
  open,
  onOpenChange,
  positions,
  instances,
  cards,
  tileLibrary,
  onAddTile,
  handoff,
  compose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * WP188：「交给岗位去做」带过来的那件事。给了就只列岗位——选一个，这件事就交过去
   * （与岗位页顶部「交给这个岗位一件事」同一条路），然后进事项页。
   */
  handoff?: Handoff
  /** WP207：左栏职责行的「+」——岗位与职责已经选好，只剩写一句话。 */
  compose?: ComposeTarget
  positions: PositionSummary[]
  /** WP70：按岗位聚合的那一份。有它就先列岗位、再列「岗位 › 职责」。 */
  instances?: PositionInstanceData[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  onAddTile: (position_id: string, tile_id: string) => void
}): React.ReactNode {
  const { t, lang, position } = useApp()
  const navigate = useNavigate()
  // WP276：在一件事里打开 ⌘K 时，多一条「把这件事交给同事…」（② 才有）
  const here = useLocation()
  const { mode: usage } = useMode()
  const matterHere = /^\/matters\/([^/?#]+)/.exec(here.pathname)?.[1]
  const rail = useRailState()
  // 岗位面装着就按岗位列（岗位在前、职责跟在后面）；没装退回按分配列
  const byPosition = (instances ?? []).filter((p) => myAssignments(p).length > 0)
  /**
   * 40 §2.2 第 1 条：⌘K 里也搜工具箱——"建之前先查"不能只在建的时候才想得起来。
   * 与工具箱页同源：都打 `GET /v1/catalog`。面板没打开就不拉（它不是首页的一部分）。
   */
  const catalog = useQuery({
    queryKey: ['catalog', 'palette'],
    enabled: open,
    queryFn: () => listCatalog({}),
  })
  /**
   * 52 O2：⌘K 里可以搜品牌名切换。
   *
   * 与顶栏切换器同一个数据源、同一条判据——个人用户（一个人一个品牌）这一组不出，
   * 进不去的品牌也不出（服务端已经筛过）。
   */
  const { org_id, brands } = useBrands()
  const client = useQueryClient()
  /** WP207：面板里打的字（要拿去搜对话与任务、也要拿去让 AI 找回）。 */
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  /** WP207：点了「让 AI 找回」之后，面板换成候选卡那一屏。 */
  const [recall, setRecall] = useState<string | undefined>(undefined)
  const [sentence, setSentence] = useState('')
  useEffect(() => {
    if (!open) {
      setSearch('')
      setRecall(undefined)
      setSentence('')
    }
  }, [open])
  useEffect(() => {
    const h = setTimeout(() => {
      setDebounced(search.trim())
    }, 200)
    return () => {
      clearTimeout(h)
    }
  }, [search])
  const works = useQuery({
    queryKey: ['matter', 'search', debounced],
    enabled: open && debounced.length >= 2,
    queryFn: () => searchWork(debounced, 8),
    retry: false,
  })
  const found = useQuery({
    queryKey: ['matter', 'recall', recall],
    enabled: open && recall !== undefined,
    queryFn: () => findArchivedWork(recall ?? ''),
    retry: false,
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    globalThis.document?.addEventListener('keydown', onKey)
    return () => {
      globalThis.document?.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  const go = (path: string): void => {
    onOpenChange(false)
    navigate(path)
  }

  const handOver = useMutation({
    mutationFn: (input: { assignment: string; handoff: Handoff; role_id?: string }) =>
      openMatterAtPosition(input.assignment, {
        title: input.handoff.title,
        ...(input.handoff.summary === '' ? {} : { summary: input.handoff.summary }),
        // WP207：从职责行的「+」来的，职责已经定了（跳过岗位内路由，与快捷提示同一条路）
        ...(input.role_id === undefined ? {} : { role_id: input.role_id }),
      }),
    onSuccess: (out, input) => {
      // 判准了直接进事项页；拿不准就去岗位页，让人在那儿点一下走哪条职责
      go(
        out.ambiguous && out.approval_item_id !== undefined
          ? `/positions/${input.assignment}`
          : `/matters/${out.matter.id}`,
      )
    },
  })

  if (compose !== undefined) {
    return (
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t('command.compose.title', { name: compose.label })}
      >
        <form
          className="flex flex-col gap-2 p-3"
          data-testid="command-compose"
          onSubmit={(e) => {
            e.preventDefault()
            const text = sentence.trim()
            if (text === '' || handOver.isPending) return
            // WP259：一大段也照收——标题取第一句…，完整原文作描述、交给 AI（原来截到 200 字）
            const split = handoffInput(text)
            handOver.mutate(
              {
                assignment: compose.assignment,
                handoff: { title: split.title, summary: split.summary ?? '' },
                role_id: compose.role_id,
              },
              {
                onSuccess: () => {
                  void client.invalidateQueries({ queryKey: RAIL_KEY })
                },
              },
            )
          }}
        >
          <span className="text-[12px] text-muted-foreground">
            {t('command.compose.title', { name: compose.label })}
          </span>
          <Input
            autoFocus
            value={sentence}
            maxLength={TASK_TEXT_MAX}
            placeholder={t('command.compose.placeholder')}
            aria-label={t('command.compose.placeholder')}
            data-testid="command-compose-input"
            onChange={(e) => {
              setSentence(e.target.value)
              if (handOver.error !== null) handOver.reset()
            }}
          />
          {handOver.isPending ? (
            <p className="text-xs text-muted-foreground" data-testid="handoff-sending">
              {t('handoff.sending')}
            </p>
          ) : null}
          <HandoffError error={handOver.error} />
        </form>
      </CommandDialog>
    )
  }

  if (recall !== undefined) {
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.recall.title')}>
        <div className="flex flex-col gap-2 p-3" data-testid="command-recall">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Sparkles aria-hidden className="size-3.5" />
            {t('command.recall', { q: recall })}
          </span>
          {found.data === undefined ? (
            <p className="text-[13px] text-muted-foreground">{t('command.recall.loading')}</p>
          ) : found.data.candidates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('archive.ai.none')}</p>
          ) : (
            <>
              <p className="text-[12px] text-muted-foreground">
                {t('archive.ai.pick')}
                {found.data.semantic ? ` · ${t('archive.ai.semantic')}` : ''}
              </p>
              <RecallCards
                compact
                candidates={found.data.candidates}
                onRestored={() => {
                  onOpenChange(false)
                }}
              />
            </>
          )}
        </div>
      </CommandDialog>
    )
  }

  if (handoff !== undefined) {
    const targets =
      byPosition.length > 0
        ? byPosition.map((p) => ({
            key: p.position_id,
            assignment: myAssignments(p)[0] as string,
            name: lang === 'en' ? p.name.en : p.name.zh,
            icon: (
              <PositionIcon
                position_id={p.position_id}
                icon={p.icon}
                role_ids={p.roles.map((r) => r.role_id)}
              />
            ),
          }))
        : positions.map((p) => ({
            key: p.position_id,
            assignment: p.position_id,
            name: p.role_name,
            icon: <PositionIcon position_id={p.position_id} role_ids={[p.role_id]} />,
          }))
    return (
      <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.handoff.title')}>
        <Command>
          <CommandInput placeholder={t('command.handoff.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('command.empty')}</CommandEmpty>
            <CommandGroup heading={t('command.handoff.title')}>
              {targets.map((target) => (
                <CommandItem
                  key={target.key}
                  value={`${target.name} ${target.key}`}
                  data-testid="command-handoff"
                  className={SELECTED_ACCENT}
                  disabled={handOver.isPending}
                  onSelect={() => {
                    handOver.mutate({ assignment: target.assignment, handoff })
                  }}
                >
                  {target.icon}
                  {target.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {handOver.isPending ? (
            <p className="px-3 pb-2 text-xs text-muted-foreground" data-testid="handoff-sending">
              {t('handoff.sending')}
            </p>
          ) : null}
          <HandoffError error={handOver.error} className="px-3 pb-2 text-xs text-destructive" />
        </Command>
      </CommandDialog>
    )
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.placeholder')}>
      <Command>
        <CommandInput
          placeholder={t('command.placeholder')}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty>{t('command.empty')}</CommandEmpty>
          {/* WP207：对话与任务（服务端全文搜；归档的也在，标出来） */}
          {debounced.length < 2 || (works.data ?? []).length === 0 ? null : (
            <CommandGroup forceMount heading={t('command.group.work')}>
              {(works.data ?? []).map((m) => (
                <CommandItem
                  key={m.id}
                  forceMount
                  value={`work ${m.id} ${m.title}`}
                  data-testid="command-work"
                  data-archived={m.archived_at === undefined ? undefined : 'true'}
                  onSelect={() => {
                    go(`/matters/${encodeURIComponent(m.id)}`)
                  }}
                >
                  <span className="truncate">{m.title}</span>
                  {m.archived_at === undefined ? null : (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Archive aria-hidden className="size-3" />
                      {t('archive.badge')}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t('command.group.go')}>
            {usage === 'solo' || matterHere === undefined ? null : (
              <CommandItem
                value={`${t('palette.handoff')} handoff`}
                data-testid="command-handoff"
                onSelect={() => {
                  go(`/matters/${matterHere}?handoff=1`)
                }}
              >
                {t('palette.handoff')}
              </CommandItem>
            )}
            {/* WP188：⌘K 里开一段新的随便聊 */}
            <CommandItem
              value={`${t('command.new_chat')} ${t('nav.free_chat')} new chat`}
              data-testid="command-new-chat"
              onSelect={() => {
                go('/free-chat?new=1')
              }}
            >
              {t('command.new_chat')}
            </CommandItem>
            <CommandItem
              onSelect={() => {
                go('/')
              }}
            >
              {t('nav.home')}
            </CommandItem>
            {/* WP70：岗位排在职责前面 */}
            {byPosition.map((p) => {
              const first = myAssignments(p)[0] as string
              return (
                <CommandItem
                  key={p.position_id}
                  value={`${lang === 'en' ? p.name.en : p.name.zh} ${p.position_id}`}
                  data-testid="command-position"
                  className={SELECTED_ACCENT}
                  onSelect={() => {
                    go(`/positions/${first}`)
                  }}
                >
                  <PositionIcon
                    position_id={p.position_id}
                    icon={p.icon}
                    role_ids={p.roles.map((r) => r.role_id)}
                  />
                  {lang === 'en' ? p.name.en : p.name.zh}
                </CommandItem>
              )
            })}
            {byPosition.flatMap((p) =>
              p.roles
                .filter((r) => r.my_assignment_id !== undefined)
                .map((r) => (
                  <CommandItem
                    key={`${p.position_id}/${r.role_id}`}
                    value={`${r.role_name} ${r.role_id}`}
                    data-testid="command-duty"
                    className={SELECTED_ACCENT}
                    onSelect={() => {
                      go(`/positions/${r.my_assignment_id as string}`)
                    }}
                  >
                    <DutyIcon role_id={r.role_id} />
                    {t('duty.of_position', {
                      position: lang === 'en' ? p.name.en : p.name.zh,
                      duty: r.role_name,
                    })}
                  </CommandItem>
                )),
            )}
            {byPosition.length > 0
              ? null
              : positions.map((p) => (
                  <CommandItem
                    key={p.position_id}
                    value={`${p.role_name} ${p.role_id}`}
                    data-testid="command-position"
                    className={SELECTED_ACCENT}
                    onSelect={() => {
                      go(`/positions/${p.position_id}`)
                    }}
                  >
                    <PositionIcon position_id={p.position_id} role_ids={[p.role_id]} />
                    {p.role_name}
                  </CommandItem>
                ))}
            <CommandItem
              onSelect={() => {
                go('/knowledge')
              }}
            >
              {t('nav.knowledge')}
            </CommandItem>
            <CommandItem
              onSelect={() => {
                go('/settings')
              }}
            >
              {t('nav.settings')}
            </CommandItem>
          </CommandGroup>
          {/* WP271：一人多品牌也要能搜品牌——只看品牌数，不看 solo */}
          {org_id === undefined || brands.length <= 1 ? null : (
            <CommandGroup heading={t('command.group.brands')}>
              {brands.map((b) => (
                <CommandItem
                  key={b.workspace_id}
                  value={`${b.name} ${t('brand.switch')}`}
                  disabled={b.current}
                  onSelect={() => {
                    onOpenChange(false)
                    if (b.current) return
                    // 切过去之后整站重载（与顶栏切换器同一条路）
                    switchBrand(org_id, b.workspace_id)
                      .then(() => {
                        enterSwitchedBrand()
                      })
                      .catch(() => undefined)
                  }}
                >
                  {b.name}
                  {b.current ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('org.brands.current')}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {cards.length === 0 ? null : (
            <CommandGroup heading={t('command.group.cards')}>
              {cards.slice(0, 20).map((card) => (
                <CommandItem
                  key={card.id}
                  value={`${card.title} ${card.summary}`}
                  onSelect={() => {
                    go(`/positions/${card.position_id}?card=${card.id}`)
                  }}
                >
                  {card.title}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(catalog.data ?? []).length === 0 ? null : (
            <CommandGroup heading={t('command.group.toolbox')}>
              {(catalog.data ?? []).slice(0, 20).map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.title} ${entry.summary}`}
                  onSelect={() => {
                    go(`/org?tab=toolbox&q=${encodeURIComponent(entry.title)}`)
                  }}
                >
                  {entry.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t(`toolbox.kind.${entry.kind}`)} · {t('toolbox.owner', { who: entry.owner })}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t('command.group.help')}>
            {HELP_SLUGS.map((slug) => (
              <CommandItem
                key={slug}
                value={`${translate('zh', `help.${slug}.title`)} ${translate('en', `help.${slug}.title`)} ${slug}`}
                data-testid="command-help"
                data-slug={slug}
                onSelect={() => {
                  onOpenChange(false)
                  // 右栏不在（极少：单测里只渲染面板）就开不出来，跳去设置页也没意义——只关面板
                  rail.openAddress(helpAddress(slug))
                }}
              >
                {t(`help.${slug}.title`)}
              </CommandItem>
            ))}
          </CommandGroup>
          {/* WP207：让 AI 找回——只给候选，点一张才放回来 */}
          {search.trim().length < 2 ? null : (
            <CommandGroup forceMount heading={t('command.archived')}>
              <CommandItem
                forceMount
                value={`recall ${search}`}
                data-testid="command-recall-item"
                onSelect={() => {
                  setRecall(search.trim())
                }}
              >
                <Sparkles aria-hidden className="size-3.5" />
                {t('command.recall', { q: search.trim() })}
              </CommandItem>
            </CommandGroup>
          )}
          {position === null ? null : (
            <CommandGroup heading={t('command.group.tiles')}>
              {tileLibrary.map((tile) => (
                <CommandItem
                  key={tile.id}
                  value={`${t('home.tiles.add')} ${tile.label}`}
                  onSelect={() => {
                    onOpenChange(false)
                    onAddTile(position, tile.id)
                  }}
                >
                  {tile.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
