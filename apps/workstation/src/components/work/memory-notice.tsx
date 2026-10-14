/**
 * WP320：「记住了：……」小提醒（照 Claude 的做法）。
 *
 * AI 跑完一件事、往记忆里新记或并进一条，这里冒一句（组件是 `design/NoticeToast`，出现规则写在它头上）：
 * - 一批里只有一条：「记住了：回复美国客户一律用英文」；好几条：「记住了 3 件事」；
 * - 人在打字时先压着，停手了再出；几秒后自己收起；
 * - 点它 = 跳到那条记忆所在的那一层（岗位页 / 职责页），第三栏开「记忆」并把那几条高亮——
 *   不想要就在那里删掉或改掉。
 *
 * 数据：每 8 秒问一次 `GET /v1/memory/changes?written_by=ai`（只回本人的）。第一次拿到的只当「已经看过」，
 * 不弹——打开工作台不该被一串旧提醒糊脸。按 id 认新旧，不靠两边的钟对得上。
 */
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { isTypingNow, NoticeToast, useLastTypedAt } from '@/components/design'
import { useRailState } from '@/components/rail/rail-state'
import { getMemoryChanges, type MemoryChangeData, type PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { myAssignments } from '@/lib/positions'

/** 多久问一次（毫秒）。 */
export const MEMORY_NOTICE_POLL_MS = 8000
/** 压着的提醒多久再看一次人停手没有（毫秒）。 */
const HOLD_RECHECK_MS = 500

/** 这一批提醒那一句。 */
export function memoryNoticeText(
  changes: readonly MemoryChangeData[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const first = changes[0]
  if (first === undefined) return ''
  if (changes.length > 1) return t('memory.notice.many', { n: changes.length })
  return t(first.kind === 'merged' ? 'memory.notice.merged' : 'memory.notice.one', {
    text: first.text,
  })
}

/**
 * 点提醒去哪：那条记忆所在那一层的页面（岗位层 → 岗位页；职责层 → 职责页；品牌层 → 当前岗位页），
 * 带上 `?memory=<条目 id,…>` 让「记忆」面板高亮。找不到本人在那一层的入口就回 `undefined`（只开面板）。
 */
export function memoryNoticePath(
  changes: readonly MemoryChangeData[],
  instances: readonly PositionInstanceData[],
  current: string | null,
): string | undefined {
  const first = changes[0]
  if (first === undefined) return undefined
  const ids = changes.filter((c) => c.tier === first.tier && c.scope_id === first.scope_id)
  const query = `?memory=${encodeURIComponent(ids.map((c) => c.entry_id).join(','))}`
  if (first.tier === 'position') {
    const hit = instances.find((p) => p.position_id === first.scope_id)
    const asg = hit === undefined ? undefined : myAssignments(hit)[0]
    return asg === undefined ? undefined : `/positions/${encodeURIComponent(asg)}${query}`
  }
  if (first.tier === 'role') {
    for (const p of instances) {
      const r = p.roles.find(
        (x) => x.role_id === first.scope_id && x.my_assignment_id !== undefined,
      )
      if (r?.my_assignment_id !== undefined)
        return `/positions/${encodeURIComponent(r.my_assignment_id)}/duties/${encodeURIComponent(r.role_id)}${query}`
    }
    return undefined
  }
  const anchor = current ?? instances.flatMap((p) => myAssignments(p))[0]
  return anchor === undefined ? undefined : `/positions/${encodeURIComponent(anchor)}${query}`
}

export function MemoryNotice({
  instances,
}: {
  instances?: readonly PositionInstanceData[]
}): ReactNode {
  const { t, position } = useApp()
  const navigate = useNavigate()
  const rail = useRailState()
  const lastTypedAt = useLastTypedAt()
  const seen = useRef(new Set<string>())
  const loaded = useRef(false)
  const since = useRef<string | undefined>(undefined)
  const [pending, setPending] = useState<MemoryChangeData[]>([])
  const [shown, setShown] = useState<MemoryChangeData[]>([])
  const [recheck, setRecheck] = useState(0)

  const changes = useQuery({
    queryKey: ['memory-changes'],
    queryFn: () => getMemoryChanges(since.current),
    refetchInterval: MEMORY_NOTICE_POLL_MS,
    retry: false,
  })

  useEffect(() => {
    const data = changes.data
    if (data === undefined) return
    const fresh = data.filter(
      (c) => !seen.current.has(c.id) && (c.kind === 'added' || c.kind === 'merged'),
    )
    for (const c of data) {
      seen.current.add(c.id)
      if (since.current === undefined || c.at > since.current) since.current = c.at
    }
    // 第一次拿到的都是打开之前的事：只记成看过，不弹
    if (!loaded.current) {
      loaded.current = true
      return
    }
    if (fresh.length > 0) setPending((p) => [...p, ...fresh])
  }, [changes.data])

  // 有压着的：人没在打字就并进正在显示的那条（同一批合成一句），在打字就过一会儿再看
  // biome-ignore lint/correctness/useExhaustiveDependencies: recheck 只用来触发再看一次
  useEffect(() => {
    if (pending.length === 0) return
    if (isTypingNow(globalThis.document?.activeElement, lastTypedAt(), Date.now())) {
      const timer = setTimeout(() => {
        setRecheck((n) => n + 1)
      }, HOLD_RECHECK_MS)
      return () => {
        clearTimeout(timer)
      }
    }
    setShown((s) => [...s, ...pending])
    setPending([])
    return undefined
  }, [pending, recheck, lastTypedAt])

  const dismiss = useCallback(() => {
    setShown([])
  }, [])

  if (shown.length === 0) return null
  return (
    <NoticeToast
      // 并进新的一条就重新计时
      key={shown.length}
      text={memoryNoticeText(shown, t)}
      icon={<Sparkles aria-hidden className="size-3.5 shrink-0 text-primary" />}
      dismissLabel={t('memory.notice.dismiss')}
      testId="memory-notice"
      onDismiss={dismiss}
      onOpen={() => {
        const path = memoryNoticePath(shown, instances ?? [], position)
        if (path !== undefined) navigate(path)
        rail.show('memory')
        setShown([])
      }}
    />
  )
}
