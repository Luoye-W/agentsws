/**
 * 公司页「进行中」看板（40 §3.3）：整个工作区正在做的事，**按主人分列**。
 *
 * 这是 owner 视角的一屏：谁手上压着几件、哪几件挂着卡等他定、最久没动的是哪一件。
 * 与其它三个 Tab 不同，它自己取数——数据只属于这一个 Tab，页面不必替它多拉一次。
 */
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { InProgressList } from '@/components/work/in-progress-list'
import { type InProgressItem, listInProgress } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 按主人分组，手上件数多的排前面（同数按展示名稳定排序）。 */
export function groupByOwner(
  items: InProgressItem[],
): { owner: string; label: string; items: InProgressItem[] }[] {
  const map = new Map<string, { owner: string; label: string; items: InProgressItem[] }>()
  for (const item of items) {
    const found = map.get(item.owner)
    if (found === undefined)
      map.set(item.owner, { owner: item.owner, label: item.owner_label, items: [item] })
    else found.items.push(item)
  }
  return [...map.values()].sort(
    (a, b) => b.items.length - a.items.length || (a.label < b.label ? -1 : 1),
  )
}

export function InprogressTab(): React.ReactNode {
  const { t } = useApp()
  const board = useQuery({
    // 挂在 `todos` 这把 key 下：WS 收到 `todo.*` 摘要就自动重取（前缀失效）
    queryKey: ['todos', 'in-progress', 'workspace'],
    queryFn: () => listInProgress('workspace'),
  })

  if (board.isPending) return <Skeleton className="h-40 w-full" />
  if (board.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{board.error.message}
      </p>
    )

  const groups = groupByOwner(board.data.items)
  if (groups.length === 0)
    return <p className="text-sm text-muted-foreground">{t('inprogress.empty')}</p>

  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="org-inprogress">
      {groups.map((group) => (
        <Card key={group.owner} data-testid="inprogress-column" data-owner={group.owner}>
          <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm">{group.label}</CardTitle>
            <Badge variant="outline">{t('inprogress.count', { n: group.items.length })}</Badge>
          </CardHeader>
          <CardContent>
            <InProgressList items={group.items} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
