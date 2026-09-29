/**
 * 设置 → 模型的**第三张卡**：「Agents 工坊（用积分）」（49 M5）。
 *
 * WP188（Luoye 09-29）：它在「加一个」列表里原来显示的是通用的「+ 填 API key」——不对，它不填 key。
 * 现在那张卡里放的就是这里的 {@link CloudPlanActions}（同一套：先关联账号 / 启用 / 看余额与用量），
 * 设置页不再另外摆一张。图标用我们自己的品牌标记，不是字母圆圈。
 *
 * 为什么另开一个件而不是塞进 `ModelsPanel` 的模板循环：那两张卡的正文是
 * "要准备什么"（去哪儿注册、复制哪一串、粘到哪里），这一张的正文恰好是
 * **什么都不用准备**——一个按钮、两个数字。塞进同一个循环就得在里面写一堆
 * `kind === 'agentsws_cloud' ? … : …`，那是把两件事硬按成一件。
 *
 * 三种状态，界面各说一句话：
 * 1. **还没关联账号** → 按钮是"先关联账号"，跳到"账号与积分"；
 * 2. **关联了但还没启用** → 按钮是"启用"，一下点完就能用（不填任何东西）；
 * 3. **已经在用** → 显示"本月用了 N 积分 · 余额 M"，外加一个"停用"。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cloud, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BrandMark } from '@/components/design'
import { TutorialLink } from '@/components/help/tutorial-link'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import {
  getCloudCredits,
  listModelProviders,
  removeModelProvider,
  saveModelProvider,
  testModelProvider,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * 这条 provider 在 `models.json` 里的 id。
 *
 * 写死一个而不是让用户起名：这一条不是"某一家"，是"我们"——一台机器上只会有一条，
 * 起第二条没有任何意义（同一把工作区令牌、同一个余额）。
 */
export const CLOUD_PROVIDER_ID = 'agentsws'

/**
 * "账号与积分"在设置页的哪个 tab。WP58 建那个 tab，这里只负责把人送过去；
 * 那个 WP 合进来之前，这个链接把人带到设置页顶部——不是死链。
 */
export const ACCOUNT_TAB_HREF = '/settings?tab=credits'

export function ModelCloudCard({ assignment }: { assignment?: string }): React.ReactNode {
  const { t } = useApp()
  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })
  if (providers.isPending) return <Skeleton className="h-28 w-full" />
  const template = providers.data?.templates.find((tpl) => tpl.kind === 'agentsws_cloud')
  return (
    <div className="rounded-lg border p-2.5" data-testid="model-cloud-card">
      <p className="flex items-center gap-2 text-sm font-medium">
        <BrandMark size={20} playOnHover />
        {t('models.cloud.title')}
        <Hint text={t('models.cloud.hint')} />
        <TutorialLink slug="agentsws-credits" className="ml-auto font-normal" />
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {template?.summary ?? t('models.cloud.summary')}
      </p>
      <CloudPlanActions {...(assignment === undefined ? {} : { assignment })} />
    </div>
  )
}

/**
 * 「Agents 工坊（用积分）」的状态与按钮（WP188 抽出来：设置页「加一个」那张卡与这张卡共用一份）。
 *
 * 三种状态各一句话：还没关联账号 →「先关联账号」（去账号与积分）；关联了没启用 →「启用」
 * （启用完接着跑三步验证）；在用 → 本月用量与余额 +「看余额与用量」+「停用」。**没有 key 输入框。**
 */
export function CloudPlanActions({ assignment }: { assignment?: string }): React.ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  // 与积分面板同一个口径：钱留两位小数，多了是噪音
  const num = (n: number): string =>
    n.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 })

  const credits = useQuery({
    queryKey: ['cloud-credits', assignment],
    queryFn: () => getCloudCredits(assignment),
    retry: false,
  })
  const providers = useQuery({
    queryKey: ['model-providers', assignment],
    queryFn: () => listModelProviders(assignment),
  })

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: ['model-providers'] })
    void client.invalidateQueries({ queryKey: ['model-defaults'] })
    void client.invalidateQueries({ queryKey: ['cloud-credits'] })
    void client.invalidateQueries({ queryKey: ['home'] })
    void client.invalidateQueries({ queryKey: ['free-chat', 'models'] })
  }

  const template = providers.data?.templates.find((tpl) => tpl.kind === 'agentsws_cloud')
  const existing = providers.data?.providers.find((p) => p.kind === 'agentsws_cloud')

  const enable = useMutation({
    mutationFn: async () => {
      const saved = await saveModelProvider(
        CLOUD_PROVIDER_ID,
        {
          kind: 'agentsws_cloud',
          // **没有 api_key**：这一条的凭据是关联账号时拿到的工作区令牌
          model: template?.default_model ?? 'deepseek-flash',
        },
        assignment,
      )
      // WP188：启用完接着跑三步验证（连通 → 文字 → 看图），与别的来源保存后同一套
      await testModelProvider(saved.id, assignment).catch(() => undefined)
      return saved
    },
    onSuccess: refresh,
  })
  const disable = useMutation({
    mutationFn: () => removeModelProvider(existing?.id ?? CLOUD_PROVIDER_ID, assignment),
    onSuccess: refresh,
  })

  if (providers.isPending) return <Skeleton className="mt-2 h-8 w-full" />

  const linked = credits.data?.linked === true
  const balance = credits.data?.balance
  const month = credits.data?.month_credits
  const busy = enable.isPending || disable.isPending
  const failed = enable.error ?? disable.error

  return (
    <div data-testid="model-cloud-actions" data-linked={linked}>
      {/* 数字只在"已经在用"时出——没启用的时候摆一行 0 是噪音 */}
      {existing !== undefined && balance !== undefined ? (
        <p className="mt-1.5 text-xs" data-slot="status" data-testid="model-cloud-numbers">
          {t('models.cloud.numbers', {
            month: num(month ?? 0),
            balance: num(balance.available),
          })}
        </p>
      ) : null}

      {credits.data?.reason === undefined || linked ? null : (
        <p
          className="mt-1.5 text-[11px] text-muted-foreground"
          data-slot="status"
          data-testid="model-cloud-reason"
        >
          {credits.data.reason}
        </p>
      )}

      {failed === null || failed === undefined ? null : (
        <p className="mt-1.5 text-[11px] text-destructive">{failed.message}</p>
      )}

      <div className="mt-2 flex items-center gap-2">
        {!linked ? (
          <Button size="sm" variant="outline" asChild data-testid="model-cloud-link-account">
            <Link to={ACCOUNT_TAB_HREF}>
              <Cloud aria-hidden />
              {t('models.cloud.link_first')}
            </Link>
          </Button>
        ) : existing === undefined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="model-cloud-enable"
            onClick={() => {
              enable.mutate()
            }}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Cloud aria-hidden />}
            {t('models.cloud.enable')}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" asChild data-testid="model-cloud-manage">
              <Link to={ACCOUNT_TAB_HREF}>{t('models.cloud.manage')}</Link>
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              data-testid="model-cloud-disable"
              onClick={() => {
                if (!globalThis.confirm(t('models.cloud.disable.confirm'))) return
                disable.mutate()
              }}
            >
              {t('models.cloud.disable')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
