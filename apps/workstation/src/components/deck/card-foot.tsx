/**
 * WP478（Luoye 10-23）：决策卡的按钮**并成卡底一排**。
 *
 * 有的卡主按钮在卡身里（方案卡的「就这样 / 修改」、岗位更新的「全部应用」、催促卡的「发出 / 修改」……），
 * 卡底另有「先不设 / 稍后」——两排按钮，人得上下找。现在卡身只**报上**它那几颗（{@link useCardFootActions}），
 * 由卡底那一排画出来：主按钮 1 颗 + 灰底次按钮，右边「→」进事项；超过 4 颗时多余的进「⋯」（`DeckActionBar`）。
 *
 * 卡身不在一张有卡底的卡里时（没人接），`useCardFootActions` 回 `false`，卡身照旧自己画那几颗。
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { cn } from '@/lib/utils'

/** 卡身报给卡底的一颗按钮。 */
export type FootAction = {
  /** 这一颗在这张卡上的名字（不重复）。 */
  key: string
  label: string
  onSelect: () => void
  /** 主按钮（品牌实底）；一张卡只有一颗。 */
  primary?: boolean
  disabled?: boolean
  testId?: string
  title?: string
}

type Register = (id: string, source: RefObject<FootAction[] | null> | null, sig: string) => void
const FootContext = createContext<Register | undefined>(undefined)

const sigOf = (actions: readonly FootAction[] | null): string =>
  actions === null
    ? ''
    : actions
        .map(
          (a) =>
            `${a.key}\u0001${a.label}\u0001${a.primary === true ? 1 : 0}\u0001${a.disabled === true ? 1 : 0}\u0001${a.title ?? ''}`,
        )
        .join('\u0002')

/**
 * 卡身用：把这几颗报给卡底。回 `true` = 有卡底接着（卡身别再自己画）；`false` = 没人接，自己画。
 * 给 `null` 或空 = 这会儿没有要放到卡底的（比如已经决定了）。一张卡里可以有几处在报（方案 + 展开的表单），
 * 卡底按它们先后排。
 */
export function useCardFootActions(actions: FootAction[] | null): boolean {
  const register = useContext(FootContext)
  const id = useId()
  const latest = useRef<FootAction[] | null>(actions)
  latest.current = actions
  const sig = sigOf(actions)
  useLayoutEffect(() => {
    if (register === undefined) return
    register(id, sig === '' ? null : latest, sig)
  }, [register, id, sig])
  useLayoutEffect(() => {
    if (register === undefined) return
    return () => {
      register(id, null, '')
    }
  }, [register, id])
  return register !== undefined
}

/**
 * 卡用：接住卡身报上来的那几颗。`wrap` 包住卡身（让它报得上来），`lead` 是现在要排在卡底最前面的那几颗
 * （点的时候取卡身最新的那一版，不会拿到过期的表单值）。
 */
export function useCardFootHost(): {
  wrap: (children: ReactNode) => ReactNode
  lead: FootAction[]
} {
  const sources = useRef(new Map<string, RefObject<FootAction[] | null>>())
  const sigs = useRef(new Map<string, string>())
  const [, setVersion] = useState('')
  const register = useCallback<Register>((id, source, sig) => {
    if (source === null) {
      sources.current.delete(id)
      sigs.current.delete(id)
    } else {
      sources.current.set(id, source)
      sigs.current.set(id, sig)
    }
    setVersion([...sigs.current.entries()].map(([k, v]) => `${k}=${v}`).join('\u0003'))
  }, [])
  const lead: FootAction[] = []
  for (const [id, source] of sources.current) {
    for (const a of source.current ?? []) {
      lead.push({
        ...a,
        // 点的时候再取最新那一版的回调（卡身每次渲染都会换）
        onSelect: () => {
          sources.current
            .get(id)
            ?.current?.find((x) => x.key === a.key)
            ?.onSelect()
        },
      })
    }
  }
  // 主按钮永远排第一颗（几处一起报时，表单的「保存」排在「收起」前面）
  lead.sort((a, b) => (b.primary === true ? 1 : 0) - (a.primary === true ? 1 : 0))
  const wrap = useCallback(
    (children: ReactNode) => (
      <FootContext.Provider value={register}>{children}</FootContext.Provider>
    ),
    [register],
  )
  return { wrap, lead }
}

/** 一颗按钮（主 = 品牌实底，其余灰底次按钮），卡身自己画、卡底画都用这一种。 */
export function FootButton({ action, className }: { action: FootAction; className?: string }) {
  return (
    <button
      type="button"
      className={cn(
        'ws-btn',
        action.primary === true ? 'ws-btn-primary' : 'ws-btn-secondary',
        className,
      )}
      disabled={action.disabled === true}
      title={action.title}
      data-testid={action.testId}
      data-foot={action.key}
      onClick={action.onSelect}
    >
      {action.label}
    </button>
  )
}

/** 没有卡底接着时，卡身自己画的那一排（和卡底同一种按钮）。 */
export function FootButtons({ actions }: { actions: readonly FootAction[] }): ReactNode {
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="card-body-actions">
      {actions.map((a) => (
        <FootButton key={a.key} action={a} />
      ))}
    </div>
  )
}
