/**
 * WP356（决策 923，Luoye 10-16「学 Claude」）：设置是一个**盖在当前页面上的大弹窗**，不再切走对话 / 工作页。
 *
 * 左边：顶上一个搜索框（按标题和说明全文搜，命中点了跳到那一项并亮一下）+ 五组导航
 * （个人 / AI / 品牌 · 当前品牌 / 这台电脑 / 团队——团队只在同事互联、公司模式出）。
 * 右边：这一节的各项，自己滚。Esc、点外面、右上角 × 都关，回到原来那一页原来的位置
 * （背后那一页一直挂着没卸，见 `App.tsx`）。
 *
 * 用的是现成的 shadcn `Dialog` 与 `Command`（cmdk：搜索结果的 ↑↓ / 回车）；没有装 shadcn 的整套
 * `Sidebar`（它带 cookie 状态、移动端抽屉、⌘B 快捷键，弹窗里用不上）——只学它「弹窗里一列侧栏」的版式。
 */

import { XIcon } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { GroupLabel, SectionHeader } from '@/components/design'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import type { SettingsGroupId, SettingsSectionId, SettingsTarget } from './route'
import {
  SETTINGS_GROUPS,
  type SettingItemView,
  type SettingSectionView,
  searchSettings,
  useSettingsCatalog,
} from './sections'

/** 跳到某一项后亮多久。 */
const FLASH_MS = 2000

export function SettingsDialog({
  target,
  onNavigate,
  onClose,
}: {
  /** 地址算出来的那一节 / 那一项（`null` = 关着）。 */
  target: SettingsTarget | null
  /** 换节 / 搜索命中：交给外面改地址（替换，不多压一条历史）。 */
  onNavigate: (section: SettingsSectionId, item?: string) => void
  onClose: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-testid="settings-dialog"
        showCloseButton={false}
        className="flex h-[min(760px,calc(100dvh-2rem))] w-[min(1080px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{t('sp.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('sp.search')}</DialogDescription>
        {target === null ? null : <SettingsBody target={target} onNavigate={onNavigate} />}
      </DialogContent>
    </Dialog>
  )
}

function SettingsBody({
  target,
  onNavigate,
}: {
  target: SettingsTarget
  onNavigate: (section: SettingsSectionId, item?: string) => void
}): ReactNode {
  const { t } = useApp()
  const { ctx, sections } = useSettingsCatalog()
  const [query, setQuery] = useState('')
  const hits = query.trim() === '' ? [] : searchSettings(sections, query)
  // 要的那一节现在看不到（不是所有者、个人模式里的团队组）→ 落在第一节
  const active = sections.find((s) => s.def.id === target.section) ?? sections[0]

  const groupLabel = (g: SettingsGroupId): string =>
    g === 'brand' && ctx.brandName !== undefined
      ? t('sp.group.brand.named', { name: ctx.brandName })
      : t(`sp.group.${g}`)

  return (
    <>
      <aside className="flex w-48 shrink-0 flex-col border-r border-ws-line bg-ws-surface md:w-60">
        <Command shouldFilter={false} className="h-full rounded-none! bg-transparent p-0">
          <div className="px-2 pt-3 pb-1">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={t('sp.search')}
              aria-label={t('sp.search')}
              data-testid="settings-search"
            />
          </div>
          {query.trim() === '' ? (
            <nav
              aria-label={t('sp.nav')}
              className="flex-1 overflow-y-auto px-2 pb-4"
              data-testid="settings-nav"
            >
              {SETTINGS_GROUPS.map((g) => {
                const inGroup = sections.filter((s) => s.def.group === g)
                if (inGroup.length === 0) return null
                return (
                  <div key={g} className="pt-3" data-testid={`settings-group-${g}`}>
                    {/* WP456-T6（§3.8 P2）：分组名 12/600 灰字（共用的 GroupLabel） */}
                    <GroupLabel className="min-w-0 px-2 pb-1">
                      <span className="truncate">{groupLabel(g)}</span>
                    </GroupLabel>
                    {inGroup.map((s) => (
                      <NavButton
                        key={s.def.id}
                        section={s}
                        active={s.def.id === active?.def.id}
                        onClick={() => {
                          onNavigate(s.def.id)
                        }}
                      />
                    ))}
                  </div>
                )
              })}
            </nav>
          ) : (
            <CommandList className="max-h-none flex-1 px-1 pb-4" data-testid="settings-search-hits">
              <CommandEmpty className="px-2 text-xs text-ws-muted-fg">
                {t('sp.search.empty')}
              </CommandEmpty>
              {hits.map((h) => (
                <CommandItem
                  key={`${h.section}:${h.def.id}`}
                  value={`${h.section}:${h.def.id}`}
                  data-testid="settings-search-hit"
                  data-setting={h.def.id}
                  onSelect={() => {
                    setQuery('')
                    onNavigate(h.section, h.def.id)
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{h.title}</span>
                    <span className="truncate text-xs text-ws-muted-fg">
                      {h.sectionTitle === h.title ? h.desc : h.sectionTitle}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          )}
        </Command>
      </aside>
      {active === undefined ? null : (
        <SectionPane key={active.def.id} section={active} item={target.item} ctx={ctx} />
      )}
    </>
  )
}

function NavButton({
  section,
  active,
  onClick,
}: {
  section: SettingSectionView
  active: boolean
  onClick: () => void
}): ReactNode {
  const Icon = section.def.icon
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      data-testid={`settings-nav-${section.def.id}`}
      className={cn(
        // WP456-T6（§3.8 P2）：每行 30 高、13 号字，28 项一屏放得下；悬停一层 `--ws-hover`
        'flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-ws-ui text-ws-body hover:bg-ws-hover',
        active && 'bg-ws-card font-medium text-ws-ink shadow-ws hover:bg-ws-card',
      )}
      ref={(el) => {
        // 直接开到靠下的一节（团队那几节）时，左栏也滚到它
        if (active) el?.scrollIntoView?.({ block: 'nearest' })
      }}
      onClick={onClick}
    >
      <Icon aria-hidden className="size-4 shrink-0 text-ws-muted-fg" />
      <span className="truncate">{section.title}</span>
    </button>
  )
}

function SectionPane({
  section,
  item,
  ctx,
}: {
  section: SettingSectionView
  item: string | undefined
  ctx: Parameters<SettingItemView['def']['render']>[0]
}): ReactNode {
  const { t } = useApp()
  const scroller = useRef<HTMLDivElement>(null)
  const [flash, setFlash] = useState<string | undefined>(item)
  const single = section.items.length === 1 ? section.items[0] : undefined

  /*
   * 要定位到某一项：滚过去、亮两秒。那一项上面的件可能还在取数（取到之后会把它往下推），
   * 所以过一会儿再对一次位置。
   */
  useEffect(() => {
    setFlash(item)
    if (item === undefined) return
    const find = (): HTMLElement | null =>
      scroller.current?.querySelector<HTMLElement>(`[data-setting="${item}"]`) ?? null
    find()?.scrollIntoView?.({ block: 'start' })
    const again = setTimeout(() => find()?.scrollIntoView?.({ block: 'start' }), 600)
    const off = setTimeout(() => setFlash(undefined), FLASH_MS)
    return () => {
      clearTimeout(again)
      clearTimeout(off)
    }
  }, [item])

  return (
    <div
      ref={scroller}
      className="min-w-0 flex-1 overflow-y-auto"
      data-testid="settings-pane"
      data-section={section.def.id}
    >
      {/*
        WP456-T6（§2.3 / §3.8）：节的页头——标题 16/600（设置里的节标题这一档）+ 一行 13 灰字；
        不再画下边线（示意稿 6），滚动时靠半透明底和内容分开
      */}
      <header
        className="sticky top-0 z-10 flex items-start gap-3 bg-popover/95 pt-5 pr-4 pb-4 pl-6 backdrop-blur"
        data-slot="page-header"
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-ws-title font-semibold text-ws-ink" data-slot="title">
            {section.title}
          </h2>
          {single === undefined || single.def.heading === true ? null : (
            <p className="mt-0.5 text-ws-ui text-ws-muted-fg">{single.desc}</p>
          )}
        </div>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('sp.close')}
            data-testid="settings-close"
          >
            <XIcon />
          </Button>
        </DialogClose>
      </header>
      <div className="flex flex-col divide-y divide-ws-line px-6 pb-10" data-slot="settings-items">
        {section.items.map((i) => (
          <div
            key={i.def.id}
            id={`setting-${i.def.id}`}
            data-setting={i.def.id}
            className={cn(
              'scroll-mt-20 py-1 transition-[box-shadow,background-color] duration-500',
              flash === i.def.id &&
                'rounded-xl bg-ws-tint/60 ring-2 ring-ws-brand/50 ring-offset-4 ring-offset-popover',
            )}
          >
            {i.def.heading === true ? (
              <div className="pt-2 pb-2">
                {/* WP456-T6：节里的小标题用共用的节标题（14/600），说明一行 13 灰字 */}
                <SectionHeader as="h3" title={i.title} />
                <p className="text-ws-ui text-ws-muted-fg">{i.desc}</p>
              </div>
            ) : null}
            {i.def.render(ctx)}
          </div>
        ))}
      </div>
    </div>
  )
}
