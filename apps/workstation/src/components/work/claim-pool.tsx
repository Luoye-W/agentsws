/**
 * 待认领池（40 §3.2）：会议 / 每日计划 / 告警 / 秘书路由抽出来的活，还没有主人。
 *
 * 一条一行、一个按钮——「我来」。点下去就是认领即锁：**第一个成功的是主人**，
 * 其余人立刻看到「已认领」（服务端回 409，这里翻成一句人话）。
 *
 * 首页那两条硬约束在这里也守着：没有表格、没有可输入的输入框（36 §3 / 首页回归题）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HandHeart, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiClientError, claimTodo, listClaimPool } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ClaimPool(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // 挂在 `home` 这把 key 下：WS 收到 `todo.*` 摘要就自动重取（realtime 已经接好）
  const pool = useQuery({ queryKey: ['home', 'claim-pool'], queryFn: () => listClaimPool() })

  const take = useMutation({
    mutationFn: (id: string) => claimTodo(id),
    onSuccess: () => {
      setFailure(undefined)
    },
    onError: (err: unknown) => {
      setFailure(
        err instanceof ApiClientError && err.details?.reason === 'already_claimed'
          ? t('claim.already', { who: String(err.details.owner ?? '') })
          : t('error.generic'),
      )
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['home'] })
      void client.invalidateQueries({ queryKey: ['todos'] })
    },
  })

  if (pool.isPending) return <Skeleton className="h-16 w-full" />
  if (pool.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{pool.error.message}
      </p>
    )
  const items = pool.data.pool
  if (items.length === 0 && failure === undefined)
    return <p className="text-sm text-muted-foreground">{t('claim.empty')}</p>

  return (
    <div className="flex flex-col gap-2" data-testid="claim-pool">
      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="claim-error">
          {failure}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li
            key={item.todo_id}
            className="flex items-center gap-2 rounded-md border px-2 py-1.5"
            data-testid="claim-row"
            data-todo={item.todo_id}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.title}</p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {item.offered_by === undefined
                  ? t(`claim.source.${item.source}`)
                  : t('claim.offered', { who: item.offered_by })}
                {item.recycled > 0 ? (
                  <span className="inline-flex items-center gap-0.5">
                    <RotateCcw className="size-3" aria-hidden />
                    {t('claim.recycled', { count: item.recycled })}
                  </span>
                ) : null}
                {item.similar_to.length > 0 ? `｜${t('claim.similar')}` : null}
              </p>
            </div>
            <Button
              size="xs"
              disabled={take.isPending}
              data-testid="claim-take"
              onClick={() => {
                take.mutate(item.todo_id)
              }}
            >
              <HandHeart className="size-3.5" aria-hidden />
              {t('claim.take')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
