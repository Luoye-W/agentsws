/**
 * WP387：信息监控连接卡上的两个按钮——「让工坊替你建」「读一遍我已有的」，外加上一趟的一句收尾。
 *
 * - 建：出一张「要在你的 Google 账号里建 N 条提醒」的卡（对话里 / 卡片流里），确认一次你的浏览器才去建；
 * - 读：你的浏览器只看一遍已有的提醒（不改），读完 RSS 的出勾选导入卡、还在发邮件的出「改成 RSS」卡；
 * - 你的浏览器没接上：两个按钮灰着，问号里说去哪接（设置 → 浏览器）。界面少字，过程在「运行中的浏览器」里看。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import { buildPrAlerts, getPrAlerts, PR_ALERTS_KEY, readPrAlerts } from '@/lib/pr-alerts-api'

export function PrAlertsActions({ assignment }: { assignment: string | undefined }): ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const [note, setNote] = useState<string | undefined>()
  const view = useQuery({
    queryKey: [...PR_ALERTS_KEY, assignment ?? ''],
    queryFn: () => getPrAlerts(assignment as string),
    enabled: assignment !== undefined,
    retry: false,
    staleTime: 30_000,
  })
  const after = (msg: string): void => {
    setNote(msg)
    void qc.invalidateQueries({ queryKey: PR_ALERTS_KEY })
    void qc.invalidateQueries({ queryKey: ['deck'] })
    void qc.invalidateQueries({ queryKey: ['approval'] })
  }
  const build = useMutation({
    mutationFn: () => buildPrAlerts(assignment as string),
    onSuccess: (r) => after(r.ok ? t('palerts.build.done', { n: r.count }) : r.reason),
  })
  const read = useMutation({
    mutationFn: () => readPrAlerts(assignment as string),
    onSuccess: (r) => after(r.ok ? t('palerts.read.done') : r.reason),
  })
  // 没装（老服务 501）就整块不画
  if (assignment === undefined || view.data === undefined) return null
  const ready = view.data.browser_ready
  const last = view.data.jobs[0]
  return (
    <div className="flex flex-col gap-1" data-testid="palerts">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!ready || build.isPending}
          data-testid="palerts-build"
          onClick={() => build.mutate()}
        >
          {t('palerts.build')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!ready || read.isPending}
          data-testid="palerts-read"
          onClick={() => read.mutate()}
        >
          {t('palerts.read')}
        </Button>
        <Hint text={ready ? t('palerts.hint') : t('palerts.not_ready')} />
      </div>
      {note === undefined && last?.summary === undefined ? null : (
        <p className="text-xs text-ws-muted-fg" data-testid="palerts-note">
          {note ?? last?.summary}
        </p>
      )}
    </div>
  )
}
