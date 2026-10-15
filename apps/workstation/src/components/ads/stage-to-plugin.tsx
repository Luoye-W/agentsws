/**
 * WP316（docs/101 §5.1④ 出口）：素材流水线这一轮「交给插件」——出一张上传表卡（L1，新建一律暂停），
 * 批了 Chrome 里的插件在你自己的后台里传，平台预览后你再确认一次。
 *
 * 一个按钮；账户不止一个时先挑。结果一句话，细的进问号；插件没连上照实说（卡照出，批了排队等插件）。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { listAdAccounts, stageAdCreativeSheet } from '@/lib/ads-changes-api'
import { useApp } from '@/lib/app-context'

export function StageToPlugin({
  assignment,
  platform,
  round_id,
  meta,
}: {
  assignment: string
  platform: 'google' | 'meta'
  round_id: string
  meta?: { page_id: string; image_hash: string }
}): ReactNode {
  const { t } = useApp()
  const accounts = useQuery({
    queryKey: ['ads-accounts', assignment, platform],
    queryFn: () => listAdAccounts(assignment, platform),
  })
  const rows = accounts.data?.rows ?? []
  const [picked, setPicked] = useState<string | undefined>()
  const account_id = picked ?? rows[0]?.id
  const stage = useMutation({
    mutationFn: () =>
      stageAdCreativeSheet(assignment, round_id, {
        account_id: account_id ?? '',
        ...(meta === undefined || meta.page_id === '' ? {} : { meta_page_id: meta.page_id }),
        ...(meta === undefined || meta.image_hash === ''
          ? {}
          : { meta_image_hash: meta.image_hash }),
      }),
  })
  if (rows.length === 0) return null
  const out = stage.data
  const staged = out?.views.some((v) => v.staged) === true
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="ads-stage-to-plugin">
      {rows.length > 1 ? (
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={account_id}
          onChange={(ev) => setPicked(ev.target.value)}
          data-testid="ads-stage-account"
        >
          {rows.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={stage.isPending || account_id === undefined}
        onClick={() => stage.mutate()}
        data-testid="ads-stage-button"
      >
        <Send className="size-4" aria-hidden />
        {t('adsc.stage')}
      </Button>
      <Hint text={t('adsc.stage.hint')} />
      {out === undefined ? null : (
        <span className="text-sm text-muted-foreground" data-testid="ads-stage-result">
          {staged ? t('adsc.stage.done') : (out.message ?? t('adsc.stage.blocked'))}
          {out.needs_connection === undefined ? '' : ` · ${t('adsc.stage.connect')}`}
        </span>
      )}
      {out?.problems === undefined || out.problems.length === 0 ? null : (
        <Hint text={out.problems.join('\n')} />
      )}
    </span>
  )
}
