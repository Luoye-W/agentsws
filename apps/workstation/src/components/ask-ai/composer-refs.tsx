/**
 * WP504（F4b / F4c）：输入框这一侧的「问 AI」——引用小卡、建议问题、`@` 搜、拖进来。
 *
 * 一个 hook 给出 `MatterComposer` 现成的几个口子（`chips` / `overlay` / `onKeyDownFirst` / `onRefDrop`），
 * 岗位页、职责页、事项页的输入框各接一次，不认任何一种资料（谁有资料谁在 `ref-sources.ts` 登记）。
 */
import { Sparkles, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import {
  addRefs,
  type ContextRef,
  type ContextRefPayload,
  clearRefs,
  refKey,
  refsPayload,
  removeRef,
  suggestionsOf,
  useAskAi,
} from './ask-ai-store'
import { type RefHit, searchRefs } from './ref-sources'

/** 光标前面是不是一个正在打的 `@词`（行首或空格后的 `@`）。纯函数，测试用。 */
export function mentionAt(text: string, caret: number): { start: number; q: string } | undefined {
  const before = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]{0,30})$/u.exec(before)
  if (m === null) return undefined
  const q = m[2] ?? ''
  return { start: caret - q.length - 1, q }
}

/** 一枚引用小卡（输入框里那一排）。 */
export function RefChip({
  item: r,
  onRemove,
}: {
  item: ContextRef
  onRemove?: () => void
}): ReactNode {
  const { t } = useApp()
  return (
    <span
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-ws-line bg-ws-surface py-0.5 pr-1 pl-1 text-[12px] text-ws-body animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
      data-testid="ask-ai-chip"
      data-ref={refKey(r)}
    >
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-full bg-ws-tint text-[12px] leading-none font-medium text-ws-brand"
      >
        {r.initial ?? r.label.slice(0, 1).toUpperCase()}
      </span>
      <span className="truncate font-medium text-ws-ink">{r.label}</span>
      {r.sub === undefined ? null : (
        <span className="shrink-0 truncate text-ws-muted-fg">· {r.sub}</span>
      )}
      {onRemove === undefined ? null : (
        <button
          type="button"
          aria-label={t('ask_ai.chip.remove', { name: r.label })}
          title={t('ask_ai.chip.remove', { name: r.label })}
          data-testid="ask-ai-chip-remove"
          className="grid size-4 shrink-0 place-items-center rounded-full text-ws-muted-fg hover:bg-muted hover:text-ws-ink"
          onClick={onRemove}
        >
          <X aria-hidden className="size-3" />
        </button>
      )}
    </span>
  )
}

/** 输入框上面那一排建议问题（点了直接问）。 */
export function AskSuggestions({
  items,
  onPick,
}: {
  items: readonly string[]
  onPick: (q: string) => void
}): ReactNode {
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="ask-ai-suggestions">
      {items.map((q) => (
        <button
          key={q}
          type="button"
          data-testid="ask-ai-suggestion"
          className="inline-flex h-7 max-w-full items-center gap-1 truncate rounded-full bg-ws-tint px-3 text-xs font-medium text-ws-brand hover:bg-ws-tint/70"
          onClick={() => {
            onPick(q)
          }}
        >
          {q}
        </button>
      ))}
    </div>
  )
}

function MentionMenu({
  hits,
  active,
  loading,
  onPick,
}: {
  hits: readonly RefHit[]
  active: number
  loading: boolean
  onPick: (hit: RefHit) => void
}): ReactNode {
  const { t } = useApp()
  return (
    <div
      role="listbox"
      aria-label={t('ask_ai.mention.label')}
      data-testid="ask-ai-mention"
      className="flex max-h-64 flex-col overflow-y-auto rounded-xl border border-ws-line bg-popover p-1 text-[13px] shadow-lg"
    >
      {hits.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-ws-muted-fg" data-testid="ask-ai-mention-empty">
          {loading ? t('ask_ai.mention.loading') : t('ask_ai.mention.none')}
        </p>
      ) : (
        hits.map((hit, i) => (
          <button
            key={refKey(hit.ref)}
            type="button"
            role="option"
            aria-selected={i === active}
            data-testid="ask-ai-mention-hit"
            data-ref={refKey(hit.ref)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left',
              i === active ? 'bg-ws-hover' : 'hover:bg-ws-hover',
            )}
            // 按下就选（不等 click：click 前输入框先失焦，菜单会先收掉）
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(hit)
            }}
          >
            <span className="min-w-0 flex-1 truncate text-ws-ink">{hit.ref.label}</span>
            <span className="shrink-0 text-xs text-ws-muted-fg">{hit.type}</span>
          </button>
        ))
      )}
    </div>
  )
}

export interface ComposerRefs {
  refs: readonly ContextRef[]
  /** 给 `MatterComposer` 的 `chips`（没有引用时是 `undefined`）。 */
  chips: ReactNode
  /** 给 `MatterComposer` 的 `overlay`（`@` 菜单）。 */
  overlay: ReactNode
  onKeyDownFirst: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** 打字时先过这一道（认 `@`），再交给调用方的 `onChange`。 */
  onChange: (next: string) => void
  onRefDrop: (refs: ContextRef[]) => void
  /** 按引用出的建议问题。 */
  suggestions: string[]
  /** 发出去时交给服务端的那一份（没有引用 = `undefined`）。 */
  payload: () => ContextRefPayload[] | undefined
  /** 发出去了：清空引用。 */
  clear: () => void
}

export function useComposerRefs({
  onChange,
  area,
}: {
  onChange: (next: string) => void
  area: RefObject<HTMLTextAreaElement | null>
}): ComposerRefs {
  const { t, lang } = useApp()
  const { refs, nonce } = useAskAi()
  const [mention, setMention] = useState<{ start: number; q: string } | undefined>(undefined)
  const [hits, setHits] = useState<RefHit[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const seq = useRef(0)

  // 放进来一张卡（点 ✦ / 拖进来 / @ 选了）→ 光标进输入框
  useEffect(() => {
    if (nonce > 0) area.current?.focus()
  }, [nonce, area])

  // `@词` 变了就搜（防抖 150ms；旧的回包不覆盖新的）
  const q = mention?.q
  useEffect(() => {
    if (q === undefined) return
    seq.current += 1
    const mine = seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      void searchRefs(q, lang).then((out) => {
        if (seq.current !== mine) return
        setHits(out)
        setActive(0)
        setLoading(false)
      })
    }, 150)
    return () => {
      clearTimeout(timer)
    }
  }, [q, lang])

  const close = (): void => {
    setMention(undefined)
    setHits([])
  }
  const pick = (hit: RefHit): void => {
    const el = area.current
    const text = el?.value ?? ''
    if (mention !== undefined) {
      const end = mention.start + 1 + mention.q.length
      onChange(`${text.slice(0, mention.start)}${text.slice(end)}`.replace(/ {2,}/gu, ' '))
    }
    close()
    addRefs([hit.ref])
  }

  return {
    refs,
    chips:
      refs.length === 0 ? undefined : (
        <>
          <Sparkles aria-hidden className="size-3.5 shrink-0 text-ws-brand" />
          {refs.map((r) => (
            <RefChip
              key={refKey(r)}
              item={r}
              onRemove={() => {
                removeRef(refKey(r))
              }}
            />
          ))}
        </>
      ),
    overlay:
      mention === undefined ? null : (
        <MentionMenu hits={hits} active={active} loading={loading} onPick={pick} />
      ),
    onKeyDownFirst: (e) => {
      if (mention === undefined) return false
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return true
      }
      if (hits.length === 0) return false
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + step + hits.length) % hits.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const hit = hits[active]
        if (hit === undefined) return false
        e.preventDefault()
        pick(hit)
        return true
      }
      return false
    },
    onChange: (next) => {
      onChange(next)
      const caret = area.current?.selectionStart ?? next.length
      setMention(mentionAt(next, caret))
    },
    onRefDrop: (dropped) => {
      addRefs(dropped)
    },
    suggestions: suggestionsOf(refs, t('ask_ai.suggest.compare')),
    payload: () => (refs.length === 0 ? undefined : refsPayload(refs)),
    clear: clearRefs,
  }
}
