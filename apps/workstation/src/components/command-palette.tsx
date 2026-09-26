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
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBrands } from '@/components/brand-switcher'
import { useRailState } from '@/components/rail/rail-state'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  listCatalog,
  type PositionInstanceData,
  type PositionSummary,
  switchBrand,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { HELP_SLUGS, helpAddress } from '@/lib/help'
import { translate } from '@/lib/i18n'
import { myAssignments } from '@/lib/positions'

export function CommandPalette({
  open,
  onOpenChange,
  positions,
  instances,
  cards,
  tileLibrary,
  onAddTile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  positions: PositionSummary[]
  /** WP70：按岗位聚合的那一份。有它就先列岗位、再列「岗位 › 职责」。 */
  instances?: PositionInstanceData[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  onAddTile: (position_id: string, tile_id: string) => void
}): React.ReactNode {
  const { t, lang, position } = useApp()
  const navigate = useNavigate()
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
  const { org_id, brands, solo } = useBrands()

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

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('command.placeholder')}>
      <Command>
        <CommandInput placeholder={t('command.placeholder')} />
        <CommandList>
          <CommandEmpty>{t('command.empty')}</CommandEmpty>
          <CommandGroup heading={t('command.group.go')}>
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
                  onSelect={() => {
                    go(`/positions/${first}`)
                  }}
                >
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
                    onSelect={() => {
                      go(`/positions/${r.my_assignment_id as string}`)
                    }}
                  >
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
                    onSelect={() => {
                      go(`/positions/${p.position_id}`)
                    }}
                  >
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
          {solo || org_id === undefined || brands.length <= 1 ? null : (
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
                      .then(() => globalThis.location?.reload())
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
