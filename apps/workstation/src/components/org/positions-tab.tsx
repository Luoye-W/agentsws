/**
 * 岗位页：一个岗位一张卡——叫什么、含哪些职责、分给了谁，以及三个动作：
 * 分给同事 / 加减职责 / 删掉。
 *
 * "岗位"在这里是 05 §2 的模板：它只在分配那一刻展开成一组职责，
 * 所以"分给了谁"是算出来的（谁名下有这个岗位的全部默认职责），不是另存一张表。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgPositionView, RoleSummaryView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export function PositionsTab({
  positions,
  roles,
  busy,
  error,
  onAssign,
  onCreate,
  onSaveRoles,
  onDelete,
}: {
  positions: OrgPositionView[]
  roles: RoleSummaryView[]
  busy: boolean
  error?: string
  onAssign(position_id: string): void
  onCreate(input: { name: string; roles: { role_id: string; default: boolean }[] }): void
  onSaveRoles(
    id: string,
    input: { name: string; roles: { role_id: string; default: boolean }[] },
  ): void
  onDelete(id: string): void
}): React.ReactNode {
  const { t } = useApp()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRoles, setNewRoles] = useState<string[]>([])

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  return (
    <div className="flex flex-col gap-3">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="positions-error">
          {error}
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {positions.map((p) => (
          <Card key={p.id} data-testid="position-card" data-position={p.id}>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm">{p.name}</CardTitle>
              <Badge variant="outline">{t('org.positions.holders', { n: p.holders.length })}</Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('org.positions.roles')}</span>
                <div className="flex flex-wrap gap-1">
                  {p.roles.map((r) => (
                    <Badge
                      key={r.role_id}
                      variant={r.default ? 'secondary' : 'outline'}
                      title={r.loaded ? undefined : t('org.positions.role.missing')}
                    >
                      {r.name}
                      {r.default ? '' : `（${t('org.positions.role.optional')}）`}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t('org.positions.who')}</span>
                {p.holders.length === 0 ? (
                  <span className="text-muted-foreground">{t('org.positions.nobody')}</span>
                ) : (
                  <div className="flex flex-wrap gap-1" data-testid="position-holders">
                    {p.holders.map((h) => (
                      <Badge key={h.person_id} variant="outline">
                        {h.name}
                        {h.ranges.length === 0 ? '' : `（${h.ranges.map((r) => r.id).join('、')}）`}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

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
