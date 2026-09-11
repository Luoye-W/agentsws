/**
 * 向导第 ④ 步那张清单（46 §1 表 ④ / §3 I5）。
 *
 * 它**不是一套新的配置界面**：每一条的"去连 / 去装"都直达已有的那张卡——
 * 平台跳 `/connections?service=<provider>`（连接页会高亮它），技能包跳 `/skills`，
 * 模型跳 `/settings`。清单只是把勾选的职责要的东西去重汇总了一遍。
 *
 * 模型没接时第一条固定是"接模型"：平台连得再全也没人替你干活。
 */
import { Circle, CircleCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import type { OnboardingPlanView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function PlanList({ plan }: { plan: OnboardingPlanView }): React.ReactNode {
  const { t } = useApp()
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
          {plan.connectors.map((c) => (
            <div
              key={c.service}
              className="flex items-start justify-between gap-3 rounded-md border p-2"
              data-testid="onboarding-plan-connector"
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
                <span className="text-xs text-muted-foreground">
                  {t('onboarding.plan.connected')}
                </span>
              ) : (
                <Button asChild size="sm" variant="outline">
                  <Link to={`/connections?service=${encodeURIComponent(c.service)}`}>
                    {t('onboarding.plan.connect')}
                  </Link>
                </Button>
              )}
            </div>
          ))}
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
                <p>{s.name}</p>
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
