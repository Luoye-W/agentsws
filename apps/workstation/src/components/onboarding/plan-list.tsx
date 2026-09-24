/**
 * 向导第 ④ 步那张清单（46 §1 表 ④ / §3 I5）。
 *
 * 它**不是一套新的配置界面**：每一条的"去连 / 去装"都直达已有的那张卡——
 * 平台跳 `/connections?service=<provider>`（连接页会高亮它），技能包跳 `/skills`，
 * 模型跳 `/settings`。清单只是把勾选的职责要的东西去重汇总了一遍。
 *
 * 模型没接时第一条固定是"接模型"：平台连得再全也没人替你干活。
 */
import { useQuery } from '@tanstack/react-query'
import { Circle, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { getConnectionDirectory, type OnboardingPlanView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/**
 * WP83（54（将改号 55）§4）：**这一步只列勾的岗位需要的**，其余收进「更多连接」。
 *
 * 为什么不干脆不给：用户在这一步会想"我的 Klaviyo 呢"。一个都不给他会以为我们不支持；
 * 二十多条全铺开又会把"你现在真正要连的这三个"淹掉。所以折叠起来，默认关着。
 *
 * 目录拉不动（还没建好分配、网络抖了）就**整块不出现**——向导不该因为一个加分项卡住。
 */
function MoreConnections({ planned }: { planned: string[] }): React.ReactNode {
  const { t, lang } = useApp()
  const [open, setOpen] = useState(false)
  const directory = useQuery({
    queryKey: ['connection-directory', 'onboarding'],
    enabled: open,
    retry: false,
    queryFn: () => getConnectionDirectory(),
  })
  // 清单里已经有的那几条不再重复出现
  const rest = (directory.data?.entries ?? []).filter(
    (e) =>
      e.status === 'available' &&
      e.connect_service !== undefined &&
      !planned.includes(e.connect_service),
  )
  return (
    <section className="flex flex-col gap-2" data-testid="onboarding-more-connections">
      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          data-testid="onboarding-more-toggle"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          {open ? t('onboarding.plan.more.close') : t('onboarding.plan.more')}
        </Button>
      </div>
      {!open || rest.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {rest.map((entry) => (
            <li
              key={entry.kind}
              className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
              data-testid="onboarding-more-entry"
            >
              <span>{lang === 'zh' ? entry.name.zh : entry.name.en}</span>
              <Button asChild size="sm" variant="outline">
                <Link
                  to={`/connections?service=${encodeURIComponent(entry.connect_service ?? '')}`}
                >
                  {t('onboarding.plan.connect')}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * WP142（docs/78 第 8 步）：技能包显示中文名。`brand-voice` 这种是包名，不是给人看的。
 * 认不出来的（第三方装的包）说「一个专用技能包」，也不露包名。
 */
const SKILL_NAMES = new Set([
  'ad-copywriting',
  'audience-research',
  'brand-system',
  'brand-voice',
  'chargeback-evidence',
  'customer-care',
  'policy-review',
  'returns-policy-calc',
  'workspace-basics',
])

export function skillLabel(name: string, t: (key: string) => string): string {
  return SKILL_NAMES.has(name) ? t(`skill.name.${name}`) : t('onboarding.plan.skill.unknown')
}

type ConnectorItem = OnboardingPlanView['connectors'][number]

/** 一行连接：必需的与展开后的可选的长一个样子。 */
function ConnectorRow({ c }: { c: ConnectorItem }): React.ReactNode {
  const { t } = useApp()
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-md border p-2"
      data-testid="onboarding-plan-connector"
      data-required={c.required}
    >
      <div className="flex items-start gap-2">
        {c.connected ? (
          <CircleCheck aria-hidden className="mt-0.5 size-4 text-primary" />
        ) : (
          <Circle aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
        )}
        <div>
          <p>
            {c.label}
            <span className="ml-2 text-xs text-muted-foreground">
              {c.required ? t('onboarding.plan.required') : t('onboarding.plan.optional')}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {t('onboarding.plan.needed_by', { roles: c.needed_by.join('、') })}
          </p>
        </div>
      </div>
      {c.connected ? (
        <span className="text-xs text-muted-foreground">{t('onboarding.plan.connected')}</span>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link to={`/connections?service=${encodeURIComponent(c.service)}`}>
            {t('onboarding.plan.connect')}
          </Link>
        </Button>
      )}
    </div>
  )
}

export function PlanList({ plan }: { plan: OnboardingPlanView }): React.ReactNode {
  const { t } = useApp()
  const [optionalOpen, setOptionalOpen] = useState(false)
  // WP142：第 ④ 步只列**必需**的；可选的折成「还有 N 个可选」，默认关着
  const required = plan.connectors.filter((c) => c.required)
  const optional = plan.connectors.filter((c) => !c.required)
  const nothing =
    !plan.model_first &&
    plan.connectors.length === 0 &&
    plan.skills.length === 0 &&
    plan.positions.length === 0

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="onboarding-plan">
      {plan.model_first ? (
        <div
          className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          data-testid="onboarding-plan-model"
        >
          <div>
            <p className="font-medium">{t('onboarding.plan.model')}</p>
            <p className="text-xs text-muted-foreground">{t('onboarding.plan.model.why')}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings">{t('onboarding.plan.model.go')}</Link>
          </Button>
        </div>
      ) : null}

      {nothing ? <p className="text-muted-foreground">{t('onboarding.plan.empty')}</p> : null}

      {plan.connectors.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <p className="font-medium">{t('onboarding.plan.connectors')}</p>
          {required.length === 0 ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="onboarding-plan-none-required"
            >
              {t('onboarding.plan.none_required')}
            </p>
          ) : (
            required.map((c) => <ConnectorRow key={c.service} c={c} />)
          )}
          {optional.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={optionalOpen}
                  data-testid="onboarding-plan-optional-toggle"
                  onClick={() => {
                    setOptionalOpen((v) => !v)
                  }}
                >
                  {optionalOpen
                    ? t('onboarding.plan.optional.close')
                    : t('onboarding.plan.optional.more', { n: optional.length })}
                </Button>
              </div>
              {optionalOpen ? optional.map((c) => <ConnectorRow key={c.service} c={c} />) : null}
            </div>
          )}
        </section>
      )}

      {plan.skills.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <p className="font-medium">{t('onboarding.plan.skills')}</p>
          {plan.skills.map((s) => (
            <div
              key={s.name}
              className="flex items-start justify-between gap-3 rounded-md border p-2"
              data-testid="onboarding-plan-skill"
            >
              <div>
                <p>{skillLabel(s.name, t)}</p>
                <p className="text-xs text-muted-foreground">
                  {t('onboarding.plan.needed_by', { roles: s.needed_by.join('、') })}
                </p>
              </div>
              {s.installed ? (
                <span className="text-xs text-muted-foreground">
                  {t('onboarding.plan.installed')}
                </span>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link to="/skills">{t('onboarding.plan.install')}</Link>
                </Button>
              )}
            </div>
          ))}
        </section>
      )}

      {/* WP83：勾的岗位要的在上面；其余收在这里，默认关着 */}
      <MoreConnections planned={plan.connectors.map((c) => c.service)} />

      {plan.positions.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <p className="font-medium">{t('onboarding.plan.positions')}</p>
          {plan.positions.map((p) => (
            <div
              key={p.position_id}
              className="rounded-md border p-2"
              data-testid="onboarding-plan-position"
            >
              <p>
                {p.name}
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('onboarding.roles.picked', { n: String(p.role_ids.length) })}
                </span>
              </p>
              {p.already_held ? (
                <p className="text-xs text-muted-foreground">{t('onboarding.plan.already_held')}</p>
              ) : null}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
