/**
 * 品牌档案（原「设置 → 通用」里的「公司档案 / 品牌档案」那张卡，WP356 搬进设置弹窗「品牌 → 品牌档案」）。
 *
 * 46 §1 末段：向导里填的那几样后续从这里改。用的是向导里同一个件（`ProfileForm`）——只有一份，
 * 改了不会两处不一致；下面接着 WP346「重新分析一次」。WP169 首页告警「目标市场按店铺后台改了」
 * 跳的 `/settings#company` 落到这一项。
 */
import { DEFAULT_BRAND_CURRENCY } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  INSIGHT_KEYS,
  type InsightKey,
  type InsightValues,
} from '@/components/onboarding/brand-insight-fields'
import {
  insightChanged,
  type ProfileDraft,
  ProfileForm,
} from '@/components/onboarding/profile-form'
import { BrandReanalyze } from '@/components/settings/brand-reanalyze'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import {
  ApiClientError,
  getCloudAccount,
  getOnboardingState,
  latestBrandIntake,
  setWorkspaceProfile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { useMode } from '@/lib/mode'

export function BrandProfileSettings({ ownerId }: { ownerId?: string }): React.ReactNode {
  const { t } = useApp()
  // WP271（决策 233）：① 个人里「公司档案」叫「品牌档案」
  const { t: tm } = useMode()
  const client = useQueryClient()
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const onboarding = useQuery({
    queryKey: ['onboarding', 'state'],
    queryFn: () => getOnboardingState(),
    retry: false,
  })
  /*
   * WP233：「公司邮箱后缀」的建议值从云账号邮箱 / 品牌客服邮箱带出（公共邮箱不带）。
   * 两样都是顺手查一下，查不到就不带——不挡这一页。
   */
  const cloudAccount = useQuery({
    queryKey: ['cloud-account', ownerId],
    queryFn: () => getCloudAccount(ownerId),
    enabled: ownerId !== undefined,
    retry: false,
  })
  const intake = useQuery({
    queryKey: ['brand-intake', 'latest', ownerId],
    queryFn: () => latestBrandIntake(ownerId),
    enabled: ownerId !== undefined,
    retry: false,
  })
  // WP248：品牌档案里存了客服邮箱就先用它（以前只能看那一轮分析）
  const supportEmail =
    onboarding.data?.profile?.support_email ?? intake.data?.profile.support_email?.value
  const save = useMutation({
    mutationFn: (draft: ProfileDraft) =>
      setWorkspaceProfile(
        {
          legal_name: draft.legal_name.trim(),
          ...(draft.domain.trim() === '' ? {} : { domain: draft.domain.trim() }),
          discoverable: draft.discoverable,
          // 48 v2 L2：设置页也能改「你卖的是」（46 §1 末段：后续从公司页和设置页都能改）
          vertical: draft.vertical,
          // WP62（51 §1 N0）：平台也能改；改成接不上的那几个之前，件里已经问过一次了
          storefront_platform: draft.storefront_platform,
          // WP65（52 O1）：品牌名（顶栏切换器显示的那一个）也从这里改
          // WP240：只在改过时发；改的是**当前品牌**（服务端按会话绑的品牌写）。公司那三样
          // 没变服务端也不碰组织——同一张表存，只写有改动的那一级
          ...(draft.brand_name.trim() === '' ||
          draft.brand_name.trim() === (onboarding.data?.brand_name ?? '')
            ? {}
            : { brand_name: draft.brand_name.trim() }),
          // WP166：目标市场——只在改过时发（原样存不该把「从官网看出来的」改成「你选的」）
          ...(sameMarkets(draft.markets, onboarding.data?.profile?.markets ?? [])
            ? {}
            : { markets: draft.markets }),
          // WP176：公司实体地址——只在改过时发（空 = 清空）
          ...(draft.postal_address.trim() === (onboarding.data?.profile?.postal_address ?? '')
            ? {}
            : { postal_address: draft.postal_address.trim() }),
          // WP248（决策 83）：品牌三格——只在改过时发（空 = 清空；币种空 = 回到 USD）
          ...(draft.one_liner.trim() === (onboarding.data?.profile?.one_liner ?? '')
            ? {}
            : { one_liner: draft.one_liner.trim() }),
          // WP335（决策 659）：品类——只在改过时发（空 = 清空）
          ...(draft.category.trim() === (onboarding.data?.profile?.category ?? '')
            ? {}
            : { category: draft.category.trim() }),
          // WP452：卖的是什么——只在改过时发（空 = 清空 = 不知道）
          ...((draft.offering ?? '') === (onboarding.data?.profile?.offering ?? '')
            ? {}
            : { offering: draft.offering ?? '' }),
          ...(draft.support_email.trim() === (onboarding.data?.profile?.support_email ?? '')
            ? {}
            : { support_email: draft.support_email.trim() }),
          // WP424：邮件营销用的哪一家——只在改过时发（空 = 清空）
          ...(draft.email_service.trim() === (onboarding.data?.profile?.email_service ?? '')
            ? {}
            : { email_service: draft.email_service.trim() }),
          ...(draft.currency.trim().toUpperCase() ===
          (onboarding.data?.profile?.currency ?? DEFAULT_BRAND_CURRENCY)
            ? {}
            : { currency: draft.currency.trim().toUpperCase() }),
          // WP346（决策 872）：第二版那几格——只发改过的（改过 = 人给的，拿掉「AI 建议」）；点过「对」的一起发
          ...insightPatch(draft.insights, onboarding.data?.profile),
          ...(draft.confirm_fields.length === 0 ? {} : { confirm_fields: draft.confirm_fields }),
        },
        ownerId,
      ),
    onSuccess: async () => {
      setFailure(undefined)
      setSaved(true)
      await client.invalidateQueries({ queryKey: ['onboarding'] })
      // WP251：「公司」一块改的是公司——下面那张「公司」卡（全称）也要跟着刷
      await client.invalidateQueries({ queryKey: ['orgs'] })
    },
    onError: (err: unknown) => {
      setFailure(err instanceof ApiClientError ? err.message : t('error.generic'))
    },
  })

  if (onboarding.data === undefined) return null
  return (
    <Card id="company" data-testid="settings-company">
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-sm">
          {tm('settings.company')}
          <Hint text={tm('settings.company.hint')} />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ProfileForm
          key={onboarding.data.profile?.set_at ?? 'new'}
          {...(onboarding.data.profile === undefined ? {} : { profile: onboarding.data.profile })}
          emailHint={onboarding.data.person.email}
          suggestFrom={[
            cloudAccount.data?.linked === true ? cloudAccount.data.email : undefined,
            supportEmail,
          ]}
          verticals={onboarding.data.verticals}
          storefrontPlatforms={onboarding.data.storefront_platforms}
          allowUnsupported
          busy={save.isPending}
          saved={saved}
          {...(failure === undefined ? {} : { error: failure })}
          onSave={(draft) => {
            save.mutate(draft)
          }}
        />
        {/* WP346（决策 872）：老品牌重新分析一次——对比「现在 / 新的」，逐格采纳 */}
        <BrandReanalyze
          {...(onboarding.data.profile === undefined ? {} : { profile: onboarding.data.profile })}
          {...(intake.data?.inputs[0]?.url === undefined
            ? {}
            : { lastUrl: intake.data.inputs[0].url })}
          {...(ownerId === undefined ? {} : { assignment: ownerId })}
        />
      </CardContent>
    </Card>
  )
}

/** 两份市场清单一样吗（顺序也算：用户挪过顺序就当改过）。 */
function sameMarkets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i])
}

/**
 * WP346：设置页那几格 → 要发的补丁（只发改过的；清空：文字给空串、人群 / 关键词给 null、竞品给空数组）。
 */
function insightPatch(
  draft: InsightValues,
  profile: Parameters<typeof insightChanged>[2],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of INSIGHT_KEYS as readonly InsightKey[]) {
    if (!insightChanged(key, draft, profile)) continue
    const v = draft[key]
    if (key === 'audience') {
      const a = draft.audience
      out.audience =
        a === undefined || a.buyers.trim() === ''
          ? null
          : {
              buyers: a.buyers.trim(),
              ...(a.payer === undefined || a.payer.trim() === '' ? {} : { payer: a.payer.trim() }),
              ...((a.concerns ?? []).length === 0 ? {} : { concerns: a.concerns }),
            }
    } else if (key === 'keywords') {
      const k = draft.keywords
      out.keywords =
        k === undefined || k.brand.length + k.category.length + k.scenario.length === 0 ? null : k
    } else if (key === 'competitors') {
      out.competitors = (draft.competitors ?? [])
        .filter((c) => c.name.trim() !== '')
        .map((c) => ({
          name: c.name.trim(),
          reason: c.reason.trim(),
          ...(c.url === undefined ? {} : { url: c.url }),
        }))
    } else out[key] = typeof v === 'string' ? v.trim() : ''
  }
  return out
}
