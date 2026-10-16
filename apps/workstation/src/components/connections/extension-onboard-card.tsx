/**
 * WP360（决策 947，Luoye 10-16）：**需要插件的岗位，一开始就引导装好插件**——不等用户说「装插件」。
 *
 * 「要不要」只从职责定义推（服务端 `GET /v1/extension/needs`），这张卡出在两处：
 * - 首次设置第 ④ 步最前（`mode="onboarding"`）：「稍后再装」只收起这一屏，不挡完成；
 * - 岗位页顶上（`mode="position"`）：常驻，「稍后」当天收起（服务端记，同一品牌所有岗位一起收）。
 *
 * 出现规则（docs/96）：要插件、还没配上 → 「装 + 配对」（复用 WP345 的装插件那一块与配对码）；
 * 配上之后这一块自己消失，换成一行「还差一步」（按岗位要的：插件里连 Reddit / 连广告后台，做完自己打勾）；
 * 都连好、方案还没设 → 「下一步：<方案名>」一个按钮，点了出 WP348 那张方案卡（进「要你处理」）；再没事就整张不画。
 * 界面少字：标题 + 一句为什么（按用途拼）+ 动作；步骤怎么点放进问号。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, Puzzle } from 'lucide-react'
import { useState } from 'react'
import { ExtensionPairingCode } from '@/components/connections/browser-extension'
import { ExtensionInstall } from '@/components/connections/extension-install'
import { useConnectAssignment } from '@/components/setup/use-connect-flow'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import {
  askExtensionPlan,
  type ExtensionNeedsView,
  getExtensionNeeds,
  snoozeExtensionNeeds,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export const EXTENSION_NEEDS_KEY = 'extension-needs'

/** 卡现在该画哪一段（纯函数，测试直接调）。 */
export function onboardPhase(
  v: ExtensionNeedsView | undefined,
  mode: 'position' | 'onboarding',
  planSent: readonly string[] = [],
): 'hidden' | 'install' | 'steps' | 'plan' | 'paired' {
  if (v === undefined || !v.needed) return 'hidden'
  if (mode === 'position' && v.snoozed) return 'hidden'
  if (!v.paired) return 'install'
  // 查不了（done 不在）的那一步不拦人：只认明说「还没」的
  if (v.steps.some((s) => s.done === false)) return 'steps'
  // 首次设置时岗位还没建出来，方案卡留给岗位页
  if (mode === 'position' && v.plans.some((p) => !p.satisfied && !planSent.includes(p.target)))
    return 'plan'
  return mode === 'onboarding' ? 'paired' : 'hidden'
}

export function ExtensionOnboardCard(props: {
  /** 这个岗位里本人那几条职责（首次设置：勾的那些）。 */
  roleIds: readonly string[]
  /** 问「要不要」用哪条分配（岗位页：本岗位那条；首次设置：所有者那条）。 */
  assignment: string | undefined
  mode: 'position' | 'onboarding'
}): React.ReactNode {
  const { t, lang } = useApp()
  const qc = useQueryClient()
  // 配对、装插件是所有者的事（与连接卡同一把尺子）
  const owner = useConnectAssignment().assignment
  const key = [EXTENSION_NEEDS_KEY, props.assignment, props.roleIds.join(',')]
  const needs = useQuery({
    queryKey: key,
    queryFn: () => getExtensionNeeds(props.roleIds, props.assignment),
    enabled: props.roleIds.length > 0 && props.assignment !== undefined,
    retry: false,
    // 人在 Chrome 里装、配对、连 Reddit 的时候这张卡自己跟着变
    refetchInterval: 4000,
  })
  const [later, setLater] = useState(false)
  const [planSent, setPlanSent] = useState<string[]>([])
  const snooze = useMutation({
    mutationFn: () => snoozeExtensionNeeds(props.roleIds, props.assignment),
    onSuccess: (v) => qc.setQueryData(key, v),
  })
  const plan = useMutation({
    mutationFn: (target: string) => askExtensionPlan(target, props.assignment),
    onSuccess: (_out, target) => {
      setPlanSent((s) => [...s, target])
      void qc.invalidateQueries({ queryKey: ['deck'] })
      void qc.invalidateQueries({ queryKey: ['home'] })
    },
  })

  const v = needs.data
  const phase = onboardPhase(v, props.mode, planSent)
  if (v === undefined || phase === 'hidden' || later) return null

  const what = v.uses.map((u) => t(`extonboard.use.${u}`)).join(lang === 'en' ? ', ' : '、')
  const nextPlan = v.plans.find((p) => !p.satisfied && !planSent.includes(p.target))

  if (phase === 'paired')
    return (
      <p
        className="flex items-center gap-2 text-sm"
        data-testid="extension-onboard"
        data-phase="paired"
      >
        <CheckCircle2 className="size-4 text-ws-good" aria-hidden />
        {t('extonboard.paired')}
      </p>
    )

  const laterButton =
    props.mode === 'position' ? (
      <span className="ml-auto flex items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={snooze.isPending}
          onClick={() => snooze.mutate()}
          data-testid="extension-onboard-later"
        >
          {t('extonboard.later')}
        </Button>
        <Hint text={t('extonboard.later.hint')} />
      </span>
    ) : (
      <Button
        size="xs"
        variant="ghost"
        className="ml-auto"
        onClick={() => setLater(true)}
        data-testid="extension-onboard-later"
      >
        {t('extonboard.onboarding.later')}
      </Button>
    )

  return (
    <section
      className="flex flex-col gap-2 rounded-lg border border-ws-line bg-ws-card p-3"
      data-testid="extension-onboard"
      data-phase={phase}
      data-mode={props.mode}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Puzzle className="size-4 text-ws-brand" aria-hidden />
        {phase === 'install' ? t('extonboard.title') : t('extonboard.next.title')}
        {laterButton}
      </div>
      {phase === 'install' ? (
        <>
          <p className="text-sm text-ws-muted-fg" data-testid="extension-onboard-why">
            {t('extonboard.why', { what })}
          </p>
          {/* WP345：随工坊带的插件装一次（打开文件夹 / 扩展页 + 三步）；不是桌面版就不出这块 */}
          <ExtensionInstall assignment={owner} paired={false} />
          <p className="text-xs text-ws-muted-fg">{t('extonboard.pair')}</p>
          <ExtensionPairingCode assignment={owner} />
          {props.mode === 'onboarding' ? (
            <p className="text-xs text-ws-muted-fg">{t('extonboard.onboarding.later.line')}</p>
          ) : null}
        </>
      ) : null}
      {phase === 'steps' ? (
        <ul className="flex flex-col gap-1" data-testid="extension-onboard-steps">
          {v.steps.map((s) => (
            <li
              key={s.step}
              className="flex items-center gap-2 text-sm"
              data-testid="extension-onboard-step"
              data-step={s.step}
              data-done={String(s.done === true)}
            >
              {s.done === true ? (
                <CheckCircle2 className="size-4 shrink-0 text-ws-good" aria-hidden />
              ) : (
                <CircleDashed className="size-4 shrink-0 text-ws-muted-fg" aria-hidden />
              )}
              {t(`extonboard.step.${s.step}`)}
            </li>
          ))}
          <li className="text-xs text-ws-muted-fg">{t('extonboard.step.hint')}</li>
        </ul>
      ) : null}
      {phase === 'plan' && nextPlan !== undefined ? (
        <div>
          <Button
            size="sm"
            disabled={plan.isPending}
            onClick={() => plan.mutate(nextPlan.target)}
            data-testid="extension-onboard-plan"
            data-target={nextPlan.target}
          >
            {t('extonboard.plan', { name: nextPlan.name })}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
