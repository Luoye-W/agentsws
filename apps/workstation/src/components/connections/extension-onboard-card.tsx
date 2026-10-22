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
 *
 * WP456-T3（§3.1「先装好浏览器插件整卡占满第一屏」）：岗位页上「还没配上」那一段降成**一行提醒**
 * （「先装好浏览器插件，这个岗位要靠它…」+ 右边「装插件」链接），点了才在下面展开装插件 + 配对码；
 * 「稍后」照旧在那一行上。卡不再画描边（规范 §2.5）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, Puzzle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExtensionPairingCode } from '@/components/connections/browser-extension'
import { ExtensionInstall } from '@/components/connections/extension-install'
import { NoticeLine } from '@/components/design/kit'
import { settingsHref } from '@/components/settings-panel/route'
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

/**
 * 装插件 + 配对那一块（少字版）：WP345 的「打开插件文件夹 / Chrome 扩展页 + 三步」+ 一句 + 配对码 + 只连本机的承诺。
 * 岗位页 / 首次设置那张卡、对话里「先连上插件」那张连接卡都用它（连接页仍是完整那一节）。
 */
export function ExtensionInstallAndPair(props: { owner: string | undefined }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-col gap-2" data-testid="extension-install-pair">
      {/* WP345：随工坊带的插件装一次（打开文件夹 / 扩展页 + 三步）；不是桌面版就不出这块 */}
      <ExtensionInstall assignment={props.owner} paired={false} />
      {/* WP416（自查 kol U4）/ WP419（自查 U12）：一句话 + 问号；「只连本机 127.0.0.1」那句技术话收进问号 */}
      <p className="flex items-center gap-1 text-xs text-ws-muted-fg">
        {t('extonboard.pair')}
        <Hint text={t('extension.local_only')} />
      </p>
      <ExtensionPairingCode assignment={props.owner} />
    </div>
  )
}

/** 令牌没起名字时的默认名（服务端 `DEFAULT_EXTENSION_LABEL`）：这时只说「插件已连上」。 */
const DEFAULT_TOKEN_LABEL = '浏览器插件'

/**
 * WP409（内测 10-18 #4）：配对成功后工坊这边的那一行——「插件已连上 · Chrome · Windows」。
 * 名字来自令牌（配对时按插件那个浏览器认出来的）；Chrome 不让扩展知道是哪个 Chrome 用户，只到浏览器 + 系统。
 */
export function ExtensionPairedLine(props: {
  withWhom: ExtensionNeedsView['paired_with']
}): React.ReactNode {
  const { t } = useApp()
  const label = props.withWhom?.label
  return (
    <p className="flex items-center gap-2 text-sm" data-testid="extension-onboard-paired-line">
      <CheckCircle2 className="size-4 shrink-0 text-ws-good" aria-hidden />
      {label === undefined || label === DEFAULT_TOKEN_LABEL
        ? t('extonboard.paired.line')
        : t('extonboard.paired.with', { who: label })}
      <Hint text={t('extonboard.paired.hint')} />
    </p>
  )
}

/** 卡现在该画哪一段（纯函数，测试直接调）。 */
export function onboardPhase(
  v: ExtensionNeedsView | undefined,
  mode: 'position' | 'onboarding',
  planSent: readonly string[] = [],
): 'hidden' | 'install' | 'steps' | 'plan' | 'paired' {
  if (v === undefined || !v.needed) return 'hidden'
  if (mode === 'position' && v.snoozed) return 'hidden'
  // WP416（自查 kol U3）：「要你处理」里已经有那张装插件连接卡——顶上这张不再重复出（配对只留一处）
  if (mode === 'position' && !v.paired && v.connect_card_id !== undefined) return 'hidden'
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
  const navigate = useNavigate()
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
  /** WP456-T3：岗位页那一行提醒点了「装插件」才展开装 + 配对。 */
  const [expanded, setExpanded] = useState(false)
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
  /*
   * WP409：看着它从「没配上」变成「配上了」——就算之后整张卡要收起（都连好了），也先留一行「插件已连上」，
   * 人在 Chrome 里输完配对码回到工坊时看得到结果。
   */
  const sawUnpaired = useRef(false)
  const [justPaired, setJustPaired] = useState(false)
  useEffect(() => {
    if (v === undefined) return
    if (!v.paired) sawUnpaired.current = true
    else if (sawUnpaired.current) setJustPaired(true)
  }, [v])
  if (v !== undefined && phase === 'hidden' && justPaired && v.paired && !later)
    return (
      <div data-testid="extension-onboard" data-phase="just-paired">
        <ExtensionPairedLine withWhom={v.paired_with} />
      </div>
    )
  if (v === undefined || phase === 'hidden' || later) return null

  const what = v.uses.map((u) => t(`extonboard.use.${u}`)).join(lang === 'en' ? ', ' : '、')
  const nextPlan = v.plans.find((p) => !p.satisfied && !planSent.includes(p.target))

  if (phase === 'paired')
    return (
      <div data-testid="extension-onboard" data-phase="paired">
        <ExtensionPairedLine withWhom={v.paired_with} />
      </div>
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

  // WP456-T3（§3.1）：岗位页上还没配上——一行提醒 +「装插件」链接，点开再给装插件与配对码
  if (props.mode === 'position' && phase === 'install')
    return (
      <div
        className="flex flex-col gap-2"
        data-testid="extension-onboard"
        data-phase={phase}
        data-mode={props.mode}
      >
        <NoticeLine
          icon={Puzzle}
          tone="info"
          end={
            <span className="flex items-center gap-1">
              <button
                type="button"
                className="ws-link-muted text-xs"
                disabled={snooze.isPending}
                title={t('extonboard.later.hint')}
                onClick={() => snooze.mutate()}
                data-testid="extension-onboard-later"
              >
                {t('extonboard.later')}
              </button>
            </span>
          }
          action={{
            label: t(expanded ? 'extonboard.collapse' : 'extonboard.install'),
            testId: 'extension-onboard-open',
            data: { 'data-expanded': expanded ? 'true' : 'false' },
            onClick: () => {
              setExpanded((x) => !x)
            },
          }}
        >
          <span data-testid="extension-onboard-why">{t('extonboard.line', { what })}</span>
        </NoticeLine>
        {expanded ? (
          <div className="rounded-xl bg-ws-card p-4 shadow-ws">
            <ExtensionInstallAndPair owner={owner} />
          </div>
        ) : null}
      </div>
    )

  return (
    <section
      className="flex flex-col gap-2 rounded-xl bg-ws-card p-4 shadow-ws"
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
          <ExtensionInstallAndPair owner={owner} />
          {props.mode === 'onboarding' ? (
            <p className="text-xs text-ws-muted-fg">{t('extonboard.onboarding.later.line')}</p>
          ) : null}
        </>
      ) : null}
      {phase === 'steps' || phase === 'plan' ? (
        <ExtensionPairedLine withWhom={v.paired_with} />
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
          <li className="flex flex-wrap items-center gap-2 text-xs text-ws-muted-fg">
            {t('extonboard.step.hint')}
            {/* WP356 起连接页收进了设置弹窗：插件那一节（配对、广告后台的同意与开关）在「设置 → 浏览器插件」 */}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => navigate(settingsHref('extension', 'extension'))}
              data-testid="extension-onboard-settings"
            >
              {t('extonboard.settings')}
            </Button>
          </li>
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
