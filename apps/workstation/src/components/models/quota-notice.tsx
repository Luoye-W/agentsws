/**
 * WP151：DeepSeek **余额不足**那一行（Luoye 09-26 定）。
 *
 * - `QuotaNotice`：模型卡 / 账号卡上的一行醒目提示 +「去充值」。账号那一路打开官方
 *   `links.topUpUrl`（充到登录的那个账号），API key 那一路打开开放平台的充值页——照官方 rc.2 的分法，
 *   免得 API key 用户把钱充到登录账号上。
 * - `QuotaChip`：顶栏上的黄色小胶囊（与「还没接模型」同一类：整个工作区的状态），点了去「设置 → 模型」。
 *
 * 余额不足**不是**登录失效：不出「重新登录」、不换模型，只提示。成功一次或余额刷新回来有钱了，
 * 服务端就不给那一格，这两处自己就没了。
 */
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { Button } from '@/components/ui/button'
import { getPositions, isDeepSeekAccountKind, listModelProviders } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function QuotaNotice({
  account,
  topUpUrl,
}: {
  /** 账号那一路（说"账号余额不足"）还是 API key 那一路（说"去开放平台充值"）。 */
  account: boolean
  topUpUrl: string | undefined
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-ws-warn-bg px-2 py-1.5 text-xs text-ws-warn"
      data-testid="model-quota"
      data-route={account ? 'account' : 'api_key'}
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 font-medium">
        {account ? t('dsa.quota') : t('models.quota.api')}
      </span>
      {topUpUrl === undefined ? null : (
        <Button
          size="xs"
          variant="outline"
          data-testid="model-quota-top-up"
          data-href={topUpUrl}
          onClick={() => {
            openExternal(topUpUrl)
          }}
        >
          {t('models.quota.top_up')}
          <ExternalLink aria-hidden className="size-3" />
        </Button>
      )}
    </div>
  )
}

/** 顶栏胶囊：哪一条 DeepSeek 余额不足了（问不到 / 不是所有者就不出，同「还没接模型」那一个）。 */
export function QuotaChip(): React.ReactNode {
  const { t } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const providers = useQuery({
    queryKey: ['model-providers', ownerId],
    enabled: ownerId !== undefined,
    retry: false,
    queryFn: () => listModelProviders(ownerId),
  })
  const hit = providers.data?.providers.find((p) => p.quota_exceeded !== undefined)
  if (hit === undefined) return null
  const message = isDeepSeekAccountKind(hit.kind) ? t('dsa.quota') : t('models.quota.api')
  return (
    <Link
      to="/settings?tab=models"
      title={message}
      data-testid="quota-chip"
      className="flex items-center gap-1 rounded-full bg-ws-warn-bg px-2 py-1 text-xs font-medium text-ws-warn"
    >
      <TriangleAlert aria-hidden className="size-3.5" />
      <span className="max-w-40 truncate">{t('models.quota.chip')}</span>
    </Link>
  )
}
