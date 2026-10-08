/**
 * 设置：这台机器上的偏好——主题、语言、当前身份，以及 **WP25 新加的「模型」**。
 *
 * WP20 之后，**连接搬到了 `/connections`**（左栏「连接」）：连接要管的东西
 * （凭据、加固状态、试连）与"深色模式"不该挤在一页里。
 *
 * 模型留在这里而不是另开一页：接模型是**一次性的**（填一把 key 就完了），
 * 之后只会偶尔来看一眼花了多少；连接是要长期管的（试连、重新授权、断开）。
 */
import { DEFAULT_BRAND_CURRENCY, isPlaceholderOwnerEmail } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { DataMapPanel } from '@/components/data-map'
import { MOTION_PREFS, setMotionPref, useMotionPref } from '@/components/design'
import { ModelsPanel } from '@/components/models/models-panel'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { ArchiveSetting } from '@/components/settings/archive-setting'
import { BackgroundCard } from '@/components/settings/background-card'
import { BrowserCard } from '@/components/settings/browser-card'
import { CloudAccountCard } from '@/components/settings/cloud-account'
import { ComputerUseCard } from '@/components/settings/computer-use-card'
import { ContentUpdatesSetting } from '@/components/settings/content-updates-setting'
import { CreditsPanel } from '@/components/settings/credits-panel'
import { DiagnosticsCard } from '@/components/settings/diagnostics-card'
import { OfficialPluginsPanel } from '@/components/settings/official-plugins'
import { RunLimitsSetting } from '@/components/settings/run-limits-setting'
import { WeeklyReviewCard } from '@/components/settings/weekly-review-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ApiClientError,
  getCloudAccount,
  getOnboardingState,
  getPositions,
  latestBrandIntake,
  listOrganizations,
  setWorkspaceProfile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SettingsPage({
  identity,
  /** WP119c：插件深链（/settings/credits 等三点）直接落在「账号与积分」那一档。 */
  defaultTab = 'general',
}: {
  identity?: string
  defaultTab?: 'general' | 'account' | 'plugins'
}): React.ReactNode {
  const { t, theme, toggleTheme, lang, setLang, position } = useApp()
  const motionPref = useMotionPref()
  const client = useQueryClient()
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // 模型 key 与连接凭据同一套权限（05 owner）：这一页显式用所有者那条岗位，
  // 而不是跟着左栏当前选中的岗位走（网关一次请求绑一个 Assignment，31 §3.1）
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id

  /**
   * 46 §1 末段：向导里填的那三样，后续从"公司"页与这一页都能改。用的是向导里
   * 同一个件（`ProfileForm`）——只有一份，改了不会两处不一致。
   */
  const onboarding = useQuery({
    queryKey: ['onboarding', 'state'],
    queryFn: () => getOnboardingState(),
    retry: false,
  })
  /**
   * 52 O1「公司」卡。
   *
   * **个人用户看不到它**（一个人、一个品牌 → `solo`）：对他来说"公司"这一层不存在，
   * 多一张卡只是多一件要理解的事。真有第二个品牌或第二个人了它才出现，
   * 而且只说三句：这家公司叫什么、有几个品牌几个人、去哪管品牌。
   */
  /*
   * WP169：首页告警区「目标市场按店铺后台改了」点开来的是 `/settings#company`——档案一到就滚到
   * 「公司档案」那一张（前端路由跳转浏览器不会自己按 # 滚）。
   */
  const { hash, search } = useLocation()
  /*
   * WP272：`?tab=account`（连接卡「去登录」、顶栏积分、存储页「去账号」都用它）真的落到「账号」那一档；
   * 老链接 `?tab=credits` 也算账号。
   */
  const tabParam = new URLSearchParams(search).get('tab')
  const initialTab =
    tabParam === 'account' || tabParam === 'credits'
      ? 'account'
      : tabParam === 'plugins' || tabParam === 'general'
        ? tabParam
        : defaultTab
  const companyReady = onboarding.data !== undefined
  useEffect(() => {
    if (hash !== '#company' || !companyReady) return
    document.getElementById('company')?.scrollIntoView?.({ block: 'start' })
  }, [hash, companyReady])
  // WP210：客户来信彻底投不进的那张卡说「设置 → 诊断」，链接 `/settings#diagnostics` 落到这一张
  useEffect(() => {
    if (hash !== '#diagnostics' || ownerId === undefined) return
    document.getElementById('diagnostics')?.scrollIntoView?.({ block: 'start' })
  }, [hash, ownerId])
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
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => listOrganizations(), retry: false })
  const org = orgs.data?.[0]
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
          ...(draft.support_email.trim() === (onboarding.data?.profile?.support_email ?? '')
            ? {}
            : { support_email: draft.support_email.trim() }),
          ...(draft.currency.trim().toUpperCase() ===
          (onboarding.data?.profile?.currency ?? DEFAULT_BRAND_CURRENCY)
            ? {}
            : { currency: draft.currency.trim().toUpperCase() }),
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

  return (
    <Tabs defaultValue={initialTab} className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="general">{t('settings.tab.general')}</TabsTrigger>
        {/* 49 M5「设置 → 账号与积分」：上半张是账号卡（WP58），下半张是积分（WP59） */}
        <TabsTrigger value="account">{t('settings.tab.account')}</TabsTrigger>
        {/* WP180：官方插件——装 / 升级 / 卸载都出卡、只列审过的；与模型 key 同一档权限（所有者） */}
        {ownerId === undefined ? null : (
          <TabsTrigger value="plugins">{t('settings.tab.plugins')}</TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="general" className="flex flex-col gap-4">
        <NoModelBanner />
        <Card data-testid="settings-general">
          <CardHeader>
            <CardTitle className="text-sm">{t('settings.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <div className="flex items-center justify-between">
              <span>{t('settings.theme')}</span>
              <Button size="sm" variant="outline" onClick={toggleTheme}>
                {theme === 'dark' ? t('theme.dark') : t('theme.light')}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <span>{t('settings.lang')}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setLang(lang === 'zh' ? 'en' : 'zh')
                }}
              >
                {lang === 'zh' ? '中文' : 'English'}
              </Button>
            </div>
            {/*
              WP195：界面动效——跟随系统（默认）/ 开 / 关。没有单独的「外观」页，
              就和主题、语言放在一起。管的是品牌标记的动效，加载转圈不归它管。
            */}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1">
                {t('settings.motion')}
                <Hint text={t('settings.motion.hint')} />
              </span>
              <fieldset
                className="inline-flex rounded-full border p-0.5 text-xs"
                aria-label={t('settings.motion')}
                data-testid="settings-motion"
              >
                {MOTION_PREFS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={m === motionPref}
                    data-value={m}
                    className={
                      m === motionPref
                        ? 'rounded-full bg-primary px-2.5 py-0.5 text-primary-foreground'
                        : 'rounded-full px-2.5 py-0.5 text-muted-foreground hover:text-foreground'
                    }
                    onClick={() => {
                      setMotionPref(m)
                    }}
                  >
                    {t(`settings.motion.${m}`)}
                  </button>
                ))}
              </fieldset>
            </div>
            {/* WP207：对话 / 任务多少天没动就自动归档（1–30 天或不自动归档） */}
            <ArchiveSetting />
            {/* WP236：一次运行多久没动静算卡死、最多跑多久 */}
            <RunLimitsSetting />
            {/* WP219：已审的内容更新——自动 / 每次问我（默认），更新过的条目可一键退回 */}
            <ContentUpdatesSetting />
            {identity === undefined ? null : (
              <div className="flex items-center justify-between">
                <span>{t('settings.identity')}</span>
                {/* WP233：本机占位邮箱不露出来 */}
                <span
                  className="font-mono text-xs text-muted-foreground"
                  data-testid="settings-identity"
                >
                  {isPlaceholderOwnerEmail(identity) ? t('identity.local_self') : identity}
                </span>
              </div>
            )}
            <Separator />
            <p className="text-muted-foreground">
              {t('settings.placeholder')}{' '}
              <Link to="/connections" className="text-primary underline-offset-4 hover:underline">
                {t('nav.connections')}
              </Link>
            </p>
          </CardContent>
        </Card>
        {onboarding.data === undefined ? null : (
          <Card id="company" data-testid="settings-company">
            <CardHeader>
              <CardTitle className="flex items-center gap-1 text-sm">
                {t('settings.company')}
                <Hint text={t('settings.company.hint')} />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/*
                46 §1 末段「后续从公司页和设置页都能改」——包括改成一个还接不上的平台
                （`allowUnsupported`），但那一下要先过一次二次确认：店铺连接会失效。
              */}
              <ProfileForm
                key={onboarding.data.profile?.set_at ?? 'new'}
                {...(onboarding.data.profile === undefined
                  ? {}
                  : { profile: onboarding.data.profile })}
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
            </CardContent>
          </Card>
        )}
        {org === undefined || org.solo ? null : (
          <Card data-testid="settings-org">
            <CardHeader>
              <CardTitle className="flex items-center gap-1 text-sm">
                {t('settings.org')}
                <Hint text={t('settings.org.hint')} testId="settings-org-hint" />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{org.legal_name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('settings.org.brands', { n: org.brands })} ·{' '}
                  {t('settings.org.members', { n: org.members })}
                </span>
              </div>
              <Link
                to="/org?tab=brands"
                className="text-primary underline-offset-4 hover:underline"
                data-testid="settings-org-manage"
              >
                {t('settings.org.manage')}
              </Link>
            </CardContent>
          </Card>
        )}
        {/*
          WP215：后台——每个品牌一套、跟着这台电脑走；这里只改「同时最多跑几件」。
          紧跟「公司」：它管的是这台电脑上所有品牌一起的事。所有者那一档权限。
        */}
        {ownerId === undefined ? null : <BackgroundCard assignment={ownerId} />}
        {/* WP224：秘书每周几、几点推「本周经营一页纸」 */}
        {ownerId === undefined ? null : <WeeklyReviewCard assignment={ownerId} />}
        {/*
          WP82（55 §3 末段）：浏览器。与模型 key 同一档权限（05 owner）——
          配浏览器是所有者的事，客服岗位看不到也改不了。放在模型前面：
          它比模型更"一次性"（配一次，之后基本不看），而模型那几张卡下面还挂着花费。
        */}
        {ownerId === undefined ? null : <BrowserCard assignment={ownerId} />}
        {/* WP144（docs/80）：电脑操控，紧跟浏览器（同一类"让 AI 动手的地方"，同一档权限） */}
        {ownerId === undefined ? null : <ComputerUseCard assignment={ownerId} />}
        {ownerId === undefined ? null : <ModelsPanel assignment={ownerId} />}
        {/*
          49 M5 那张「Agents 工坊（用积分）」卡：WP188 起就在上面「加一个」里（同一个组件
          `CloudPlanActions`：先关联账号 / 启用 / 看余额与用量），这里不再另摆一张。
        */}
        {/*
          WP152：「用我的 DeepSeek 账号登录」原来是这里单独一张卡；现在收进上面「加一个」里的
          「DeepSeek 官方」卡（二选一：官方账户登录 / 官方 API 接口连接），这里不再重复一张。
        */}
        {/*
        47 J1 数据地图：按**当前选中的那条岗位**裁剪（登记表是按岗位的，
        不像模型 key 那样统一走所有者）。左栏还没选岗位时这一块不出。
      */}
        {position === null ? null : <DataMapPanel position={position} />}
        {/*
          WP210：诊断——没进来的信（系统自己按退避重投，放弃了的记在这里，手动「重投」只在这里）。
          与连接同一档权限（所有者），放在最后：平时用不着，排查时才来。
        */}
        {ownerId === undefined ? null : <DiagnosticsCard assignment={ownerId} />}
      </TabsContent>
      <TabsContent value="account" className="flex flex-col gap-4">
        <CloudAccountCard {...(ownerId === undefined ? {} : { assignment: ownerId })} />
        <CreditsPanel />
      </TabsContent>
      {ownerId === undefined ? null : (
        <TabsContent value="plugins" className="flex flex-col gap-4">
          <OfficialPluginsPanel assignment={ownerId} />
        </TabsContent>
      )}
    </Tabs>
  )
}

/** 两份市场清单一样吗（顺序也算：用户挪过顺序就当改过）。 */
function sameMarkets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i])
}
