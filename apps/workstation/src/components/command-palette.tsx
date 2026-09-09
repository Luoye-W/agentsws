/**
 * 36 §3 第三个对话入口：⌘K 命令面板——**搜索、跳转、加一个数字块**。
 *
 * 它不是聊天框：每一项都是一个确定的动作（跳到某张卡 / 某个岗位，或往首页加一个数字块），
 * 没有自由文本会被送去问模型。工作台**没有全局聊天框**（36 §3 A4）。
 */
import type { DeckCard, TileSpec } from '@agentsws/deck'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import type { PositionSummary } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function CommandPalette({
  open,
  onOpenChange,
  positions,
  cards,
  tileLibrary,
  onAddTile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  positions: PositionSummary[]
  cards: DeckCard[]
  tileLibrary: TileSpec[]
  onAddTile: (position_id: string, tile_id: string) => void
}): React.ReactNode {
  const { t, position } = useApp()
  const navigate = useNavigate()

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
            {positions.map((p) => (
              <CommandItem
                key={p.position_id}
                value={`${p.role_name} ${p.role_id}`}
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
