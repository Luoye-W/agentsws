/**
 * WP69（54 §3）：一层记忆。
 *
 * 岗位页的「记忆」tab 与职责那一层的「记忆」小节共用这一个件——它们看的是同一种东西，
 * 只是 `tier` / `scope_id` 不同：
 *
 * - 岗位层记的是"这家公司的网站运营怎么做事"；
 * - 职责层记的是"这条活儿的专业教训"。
 *
 * **只读**。改这一层的唯一办法是「提到这一层」：走 learning 的提议 → 批准那条路
 * （24 §3 只产提议、不自动改）。所以这里的按钮出来的是一张卡，不是一次写入。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpFromLine, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getLayerMemory, promoteSkillTo } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function LayerMemory({
  tier,
  scopeId,
}: {
  tier: 'company' | 'department' | 'position' | 'role'
  scopeId?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const memory = useQuery({
    queryKey: ['layer-memory', tier, scopeId ?? ''],
    queryFn: () => getLayerMemory(tier, scopeId),
  })
  const promote = useMutation({
    mutationFn: (input: { skill: string; section_id: string }) =>
      promoteSkillTo({
        skill: input.skill,
        section_ids: [input.section_id],
        to_tier: tier,
        ...(scopeId === undefined ? {} : { scope_id: scopeId }),
      }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['layer-memory', tier, scopeId ?? ''] })
    },
  })

  if (memory.isPending) return <Skeleton className="h-32 w-full" />
  if (memory.error !== null || memory.data === undefined) return null
  const view = memory.data

  return (
    <div className="flex flex-col gap-3" data-testid="layer-memory" data-tier={tier}>
      <p className="text-sm text-muted-foreground">{view.summary}</p>
      {view.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="layer-memory-empty">
          {t('memory.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {view.entries.map((e) => (
            <li
              key={`${e.skill}:${e.section_id}`}
              className="rounded-md border p-3"
              data-testid="memory-entry"
              data-origin={e.origin}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{e.heading ?? e.skill}</span>
                {/* 06 §3.4：学来的段在界面上有标记 */}
                {e.origin === 'learned' ? (
                  <span className="inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-[11px]">
                    <Sparkles className="size-3" aria-hidden />
                    {t('memory.learned')}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {e.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={promote.isPending}
          data-testid="promote-to-layer"
          onClick={() => {
            const first = view.entries[0]
            if (first === undefined) return
            promote.mutate({ skill: first.skill, section_id: first.section_id })
          }}
        >
          <ArrowUpFromLine className="size-3.5" aria-hidden />
          {t(`memory.promote.${tier}`)}
        </Button>
        {/* 提上去不是写进去：出的是一张待审的卡（24 §3） */}
        <Hint text={t('memory.promote.hint')} />
        {promote.data === undefined ? null : (
          <span className="text-[11px] text-muted-foreground" data-testid="promote-result">
            {promote.data.accepted ? t('memory.promote.ok') : promote.data.reason}
          </span>
        )}
      </div>
    </div>
  )
}
