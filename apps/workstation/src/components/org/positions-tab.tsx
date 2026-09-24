/**
 * 公司页「岗位」tab：一个岗位一行——岗位名、持有人、职责数，三个动作
 * （分给同事 / 加减职责 / 删掉）。
 *
 * WP70（54 §4，Luoye 09-16）：**职责一律归在岗位下面，默认折叠收纳**。
 * 以前这一页顶上还有一个独立的「职责」tab，岗位卡上的职责也是摊开的一排徽章——
 * 于是"这家公司有什么"被同一批东西讲了两遍，一遍按岗位、一遍按职责。现在只剩
 * 一遍：职责在岗位行下面那个折叠层里，点开才看得见，每条旁边的动作（复制一份 /
 * 改名与额度 / 已提交审批）就是原「职责」tab 那一套（`RoleDetail`）。
 *
 * "岗位"在这里是 05 §2 的模板：它只在分配那一刻展开成一组职责，
 * 所以"分给了谁"是算出来的（谁名下有这个岗位的全部默认职责），不是另存一张表。
 */
import { useState } from 'react'
import { type RoleChangePatch, RoleDetail } from '@/components/org/roles-tab'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DutyFold } from '@/components/ui/duty-fold'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgPositionView, RoleSummaryView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { rangeText } from '@/lib/ranges'
import { cn } from '@/lib/utils'

/** 持有人一枚：一个首字的圆头像 + 名字（+ 他管的范围）。 */
function Holder({
  name,
  ranges,
}: {
  name: string
  ranges: { kind: string; id: string }[]
}): React.ReactNode {
  const { t } = useApp()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-xs">
      <span
        aria-hidden
        className="flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[11px]"
      >
        {name.slice(0, 1)}
      </span>
      {name}
      {ranges.length === 0 ? null : (
        <span className="text-muted-foreground">
          （{ranges.map((r) => rangeText(r, t)).join('、')}）
        </span>
      )}
    </span>
  )
}

export function PositionsTab({
  positions,
  roles,
  submitted,
  busy,
  error,
  onAssign,
  onCreate,
  onSaveRoles,
  onDelete,
  onCopyRole,
  onProposeRole,
}: {
  positions: OrgPositionView[]
  roles: RoleSummaryView[]
  /** 刚提交过审批的职责 id（折叠层里那条显示「已提交审批」）。 */
  submitted?: string
  busy: boolean
  error?: string
  onAssign(position_id: string): void
  onCreate(input: { name: string; roles: { role_id: string; default: boolean }[] }): void
  onSaveRoles(
    id: string,
    input: { name: string; roles: { role_id: string; default: boolean }[] },
  ): void
  onDelete(id: string): void
  /** 原「职责」tab 的两个动作，现在挂在折叠层里每条职责下面。 */
  onCopyRole(id: string): void
  onProposeRole(id: string, patch: RoleChangePatch): void
}): React.ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRoles, setNewRoles] = useState<string[]>([])
  // 折叠层里展开看规矩的那一条职责（一次一条：`岗位 id / 职责 id`）
  const [detail, setDetail] = useState<string | null>(null)

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  return (
    <div className="flex flex-col gap-3">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="positions-error">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {positions.map((p) => (
          <Card key={p.id} data-testid="position-card" data-position={p.id}>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                {p.name}
                <Badge variant="outline" data-testid="position-duty-count">
                  {t('org.positions.duties', { count: p.roles.length })}
                </Badge>
              </CardTitle>
              {p.holders.length === 0 ? (
                <span className="text-muted-foreground text-xs">{t('org.positions.nobody')}</span>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="position-holders">
                  {p.holders.map((h) => (
                    <Holder key={h.person_id} name={h.name} ranges={h.ranges} />
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {/* WP70：职责是第二层，默认折叠；点开才看得到这个岗位含哪几条 */}
              <DutyFold
                testId="position-duties"
                duties={p.roles.map((r) => ({ id: r.role_id, name: r.name }))}
                renderDuty={(duty) => {
                  const inPosition = p.roles.find((r) => r.role_id === duty.id)
                  const full = roles.find((r) => r.id === duty.id)
                  const key = `${p.id}/${duty.id}`
                  const open = detail === key
                  return (
                    <div className="rounded-md border" data-testid="position-duty">
                      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
                        <span className="flex items-center gap-1.5">
                          {duty.name}
                          {inPosition?.default === false ? (
                            <Badge variant="outline">{t('org.positions.role.optional')}</Badge>
                          ) : null}
                          {inPosition?.loaded === false ? (
                            <Badge variant="destructive">{t('org.positions.role.missing')}</Badge>
                          ) : null}
                        </span>
                        {full === undefined ? null : (
                          <Button
                            size="xs"
                            variant="ghost"
                            data-testid="position-duty-detail"
                            onClick={() => {
                              setDetail(open ? null : key)
                            }}
                          >
                            {open ? t('org.positions.duty.close') : t('org.positions.duty.detail')}
                          </Button>
                        )}
                      </div>
                      {/* 原「职责」tab 的那张说明卡：复制一份 / 改名与额度 / 已提交审批 */}
                      {open && full !== undefined ? (
                        <div className="border-t p-2">
                          <RoleDetail
                            key={full.id}
                            role={full}
                            {...(submitted === undefined ? {} : { submitted })}
                            busy={busy}
                            onCopy={onCopyRole}
                            onPropose={onProposeRole}
                          />
                        </div>
                      ) : null}
                    </div>
                  )
                }}
              />

              {editing === p.id ? (
                <div className="flex flex-col gap-2 rounded-md border p-2">
                  <span className="text-xs text-muted-foreground">{t('org.positions.pick')}</span>
                  <div className="flex flex-wrap gap-1">
                    {roles.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        data-testid="position-role-toggle"
                        className={cn(
                          'rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted',
                          draft.includes(r.id) && 'border-primary bg-primary/10',
                        )}
                        onClick={() => {
                          setDraft((current) => toggle(current, r.id))
                        }}
                      >
                        {r.name}
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(null)
                      }}
                    >
                      {t('org.cancel')}
                    </Button>
                    <Button
                      size="sm"
                      disabled={draft.length === 0 || busy}
                      data-testid="position-save"
                      onClick={() => {
                        onSaveRoles(p.id, {
                          name: p.name,
                          roles: draft.map((role_id) => ({ role_id, default: true })),
                        })
                        setEditing(null)
                      }}
                    >
                      {t('org.save')}
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="position-assign"
                  onClick={() => {
                    onAssign(p.id)
                  }}
                >
                  {t('org.positions.assign')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(p.id)
                    setDraft(p.roles.filter((r) => r.default).map((r) => r.role_id))
                  }}
                >
                  {t('org.positions.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="position-delete"
                  disabled={busy}
                  onClick={() => {
                    onDelete(p.id)
                  }}
                >
                  {t('org.positions.delete')}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {creating ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('org.positions.new')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-position-name">{t('org.positions.name')}</Label>
              <Input
                id="new-position-name"
                value={newName}
                placeholder={t('org.positions.name.hint')}
                onChange={(e) => {
                  setNewName(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t('org.positions.pick')}</span>
              <div className="flex flex-wrap gap-1">
                {roles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-testid="new-position-role"
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted',
                      newRoles.includes(r.id) && 'border-primary bg-primary/10',
                    )}
                    onClick={() => {
                      setNewRoles((current) => toggle(current, r.id))
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreating(false)
                }}
              >
                {t('org.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="new-position-save"
                disabled={newName.trim() === '' || newRoles.length === 0 || busy}
                onClick={() => {
                  onCreate({
                    name: newName.trim(),
                    roles: newRoles.map((role_id) => ({ role_id, default: true })),
                  })
                  setCreating(false)
                  setNewName('')
                  setNewRoles([])
                }}
              >
                {t('org.positions.create')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="position-new"
            onClick={() => {
              setCreating(true)
            }}
          >
            {t('org.positions.new')}
          </Button>
        </div>
      )}
    </div>
  )
}
