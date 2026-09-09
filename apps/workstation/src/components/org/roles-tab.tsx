/**
 * 职责页：左边一列职责，右边一张"这个职责是什么"的说明。
 *
 * 两条纪律照 05 §0：
 * - **内置模板只读**：想改就先「复制一份」，改自己那一份，原模板永远是原样；
 * - **改了不立刻生效**：提交之后显示「已提交审批」——它变成首页队列里的一张卡，
 *   批了才落到在岗同事身上（14 §1 `policy_change`）。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { RoleSummaryView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function RolesTab({
  roles,
  submitted,
  busy,
  error,
  onCopy,
  onPropose,
}: {
  roles: RoleSummaryView[]
  /** 刚提交过审批的职责 id（界面上显示「已提交审批」）。 */
  submitted?: string
  busy: boolean
  error?: string
  onCopy(id: string): void
  onPropose(
    id: string,
    patch: {
      name?: string
      description?: string
      actions?: { id: string; caps?: Record<string, number> }[]
    },
  ): void
}): React.ReactNode {
  const { t } = useApp()
  const [selected, setSelected] = useState<string | null>(roles[0]?.id ?? null)
  // null = 没动过（清空输入框应该是空的，不是又弹回原名）
  const [name, setName] = useState<string | null>(null)
  const [caps, setCaps] = useState<Record<string, string>>({})

  const role = roles.find((r) => r.id === selected) ?? roles[0]

  /** 动作 id → 人话；没写译文就退回 id（新职责包里的动作不会因此消失）。 */
  const actionLabel = (id: string): string => {
    const key = `org.action.${id}`
    const text = t(key)
    return text === key ? id : text
  }

  const start = (r: RoleSummaryView): void => {
    setSelected(r.id)
    setName(null)
    const next: Record<string, string> = {}
    for (const action of r.actions)
      for (const cap of action.caps)
        if (!Number.isNaN(Number(cap.value))) next[`${action.id}.${cap.key}`] = cap.value
    setCaps(next)
  }

  return (
    <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
      <div className="flex flex-col gap-1">
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            data-testid="role-row"
            className={cn(
              'flex items-center justify-between rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
              role?.id === r.id && 'border-primary bg-primary/10',
            )}
            onClick={() => {
              start(r)
            }}
          >
            <span>{r.name}</span>
            <Badge variant={r.source === 'custom' ? 'secondary' : 'outline'}>
              {r.source === 'custom' ? t('org.roles.custom') : t('org.roles.bundled')}
            </Badge>
          </button>
        ))}
      </div>

      {role === undefined ? null : (
        <Card data-testid="role-detail">
          <CardHeader className="flex-row items-center justify-between gap-2">
            <CardTitle className="text-sm">{role.name}</CardTitle>
            <Badge variant="outline">{t('org.roles.holders', { n: role.holders })}</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p className="text-muted-foreground">{role.description}</p>

            <section className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('org.roles.blocks')}</span>
              <div className="flex flex-wrap gap-1">
                {role.home_blocks.length === 0 ? (
                  <span className="text-muted-foreground">{t('org.roles.blocks.none')}</span>
                ) : (
                  role.home_blocks.map((b) => (
                    <Badge key={b.id} variant="outline">
                      {t(`org.placement.${b.placement}`)}
                    </Badge>
                  ))
                )}
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">{t('org.roles.actions')}</span>
              {role.actions.length === 0 ? (
                <span className="text-muted-foreground">{t('org.roles.actions.none')}</span>
              ) : (
                role.actions.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-md border px-2 py-1.5"
                    data-testid="role-action"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{actionLabel(a.id)}</span>
                      <span className="text-xs text-muted-foreground">
                        {t(`org.route.${a.route_to}`)}
                      </span>
                    </div>
                    {a.caps.length === 0 && a.window === undefined ? null : (
                      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                        {a.caps.map((cap) => (
                          <span key={cap.key} className="rounded bg-muted px-1.5 py-0.5">
                            {cap.key}：{cap.value}
                          </span>
                        ))}
                        {a.window === undefined ? null : (
                          <span className="rounded bg-muted px-1.5 py-0.5">
                            {t('org.roles.window', {
                              n: a.window.max_count,
                              per: t(`org.per.${a.window.per}`),
                            })}
                          </span>
                        )}
                      </div>
                    )}
                    {role.editable ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {a.caps
                          .filter((cap) => !Number.isNaN(Number(cap.value)))
                          .map((cap) => (
                            <div key={cap.key} className="flex items-center gap-1">
                              <Label
                                htmlFor={`cap-${a.id}-${cap.key}`}
                                className="text-xs text-muted-foreground"
                              >
                                {cap.key}
                              </Label>
                              <Input
                                id={`cap-${a.id}-${cap.key}`}
                                className="h-7 w-24"
                                inputMode="numeric"
                                value={caps[`${a.id}.${cap.key}`] ?? cap.value}
                                onChange={(e) => {
                                  setCaps((current) => ({
                                    ...current,
                                    [`${a.id}.${cap.key}`]: e.target.value,
                                  }))
                                }}
                              />
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </section>

            <section className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{t('org.roles.automation')}</span>
              <div className="flex flex-wrap gap-1">
                {role.automation.length === 0 ? (
                  <span className="text-muted-foreground">{t('org.roles.automation.none')}</span>
                ) : (
                  role.automation.map((a) => (
                    <Badge key={a.action_id} variant="outline">
                      {actionLabel(a.action_id)}：{t(`org.level.${a.ceiling}`)}
                    </Badge>
                  ))
                )}
              </div>
            </section>

            {role.editable ? (
              <section className="flex flex-col gap-2 rounded-md border p-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="role-name">{t('org.roles.rename')}</Label>
                  <Input
                    id="role-name"
                    value={name ?? role.name}
                    onChange={(e) => {
                      setName(e.target.value)
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{t('org.roles.approval_note')}</p>
                  <Button
                    size="sm"
                    data-testid="role-submit"
                    disabled={busy}
                    onClick={() => {
                      const actions = role.actions
                        .map((a) => {
                          const changed: Record<string, number> = {}
                          for (const cap of a.caps) {
                            const value = caps[`${a.id}.${cap.key}`]
                            if (value === undefined || value === cap.value) continue
                            const n = Number(value)
                            if (!Number.isNaN(n)) changed[cap.key] = n
                          }
                          return Object.keys(changed).length === 0
                            ? undefined
                            : { id: a.id, caps: changed }
                        })
                        .filter(
                          (x): x is { id: string; caps: Record<string, number> } => x !== undefined,
                        )
                      onPropose(role.id, {
                        ...(name === null || name.trim() === '' || name === role.name
                          ? {}
                          : { name }),
                        ...(actions.length === 0 ? {} : { actions }),
                      })
                    }}
                  >
                    {t('org.roles.submit')}
                  </Button>
                </div>
                {submitted === role.id ? (
                  <p className="text-xs text-primary" data-testid="role-submitted">
                    {t('org.roles.submitted')}
                  </p>
                ) : null}
              </section>
            ) : (
              <section className="flex items-center justify-between gap-2 rounded-md border p-2">
                <p className="text-xs text-muted-foreground">{t('org.roles.copy_note')}</p>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="role-copy"
                  disabled={busy}
                  onClick={() => {
                    onCopy(role.id)
                  }}
                >
                  {t('org.roles.copy')}
                </Button>
              </section>
            )}

            {error === undefined ? null : (
              <p role="alert" className="text-destructive" data-testid="roles-error">
                {error}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
