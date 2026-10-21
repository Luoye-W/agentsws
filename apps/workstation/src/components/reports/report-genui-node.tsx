/**
 * WP438（决策 847：对话和面板用同一套组件）：对话里 genui 的 `ws-report` 节点——只带报表 id，
 * 数由这里按 id 从服务端取（不经模型手），画成和「做一份报表」里同一个小报表；「展开看」在第三栏拉出整页，
 * 草稿可以就地「固定到面板」（固定到它自己那个岗位、照它的频率）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { HostGenuiProps } from '@/components/answer/genui/primitives-shim'
import { MiniReport } from '@/components/reports/kit/mini-report'
import { markPinned, openRightPane } from '@/components/reports/right-pane'
import { getReport, pinReport, REPORTS_QUERY } from '@/lib/reports-api'

export function ReportGenuiNode({ node }: HostGenuiProps): ReactNode {
  const id = typeof node.id === 'string' ? node.id : ''
  const client = useQueryClient()
  const report = useQuery({
    queryKey: [...REPORTS_QUERY, 'one', id, 'default', 'now'],
    queryFn: () => getReport({ id }),
    enabled: id !== '',
    retry: false,
  })
  const pin = useMutation({
    mutationFn: () =>
      pinReport({
        id,
        position: report.data?.position ?? '',
        refresh: report.data?.refresh ?? 'daily',
      }),
    onSuccess: (s) => {
      markPinned(s.id)
      void client.invalidateQueries({ queryKey: REPORTS_QUERY })
    },
  })
  const data = report.data
  if (data === undefined) return null
  return (
    <div data-testid="genui-report">
      <MiniReport
        data={data}
        pinned={!id.startsWith('draft_') || pin.isSuccess}
        {...(id.startsWith('draft_')
          ? {
              onPin: () => {
                pin.mutate()
              },
            }
          : {})}
        onExpand={() => {
          openRightPane({ kind: 'report', id: pin.data?.id ?? id, position: data.position })
        }}
      />
    </div>
  )
}
