/**
 * WP207：岗位行上的「+」——给这个岗位**加职责**（就地展开，不跳公司页）。
 *
 * 与公司页「加减职责」同一条路：改岗位模板（`PUT /v1/org/positions/:id`，原有的职责与
 * 默认勾选原样带上），再把新加的职责分给自己（范围沿用我在这个岗位上的那一份）。
 * 拆过的老职责不给新勾（`pickableRoles`，WP202）；岗位里已经有的不再列。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { pickableRoles } from '@/components/org/positions-tab'
import { Button } from '@/components/ui/button'
import {
  ApiClientError,
  createAssignments,
  listOrgPositions,
  listRoleDefinitions,
  updateOrgPosition,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { RAIL_KEY } from '@/lib/work-archive'

export function AddDutyInline({
  owner,
  person_id,
  position_id,
  onDone,
  onCancel,
}: {
  owner: string
  person_id: string
  /** 岗位模板 id。 */
  position_id: string
  onDone: () => void
  onCancel: () => void
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [picked, setPicked] = useState<string[]>([])
  const box = useRef<HTMLDivElement>(null)
  const positions = useQuery({
    queryKey: ['org', 'positions', owner],
    queryFn: () => listOrgPositions(owner),
  })
  const roles = useQuery({
    queryKey: ['org', 'roles', owner],
    queryFn: () => listRoleDefinitions(owner),
  })
  const template = positions.data?.find((p) => p.id === position_id)
  const held = template?.roles.map((r) => r.role_id) ?? []
  const choices = pickableRoles(roles.data ?? []).filter((r) => !held.includes(r.id))
  // 打开、清单到了就把焦点给第一项：从「+」键盘进来的人接着能挑
  const ready = choices.length > 0
  useEffect(() => {
    if (ready) box.current?.querySelector<HTMLElement>('button')?.focus()
  }, [ready])

  const add = useMutation({
    mutationFn: async () => {
      if (template === undefined) return
      await updateOrgPosition(
        position_id,
        {
          name: template.name,
          roles: [
            ...template.roles.map((r) => ({ role_id: r.role_id, default: r.default })),
            ...picked.map((role_id) => ({ role_id, default: true })),
          ],
        },
        owner,
      )
      const ranges = template.holders.find((h) => h.person_id === person_id)?.ranges ?? []
      for (const role_id of picked) await createAssignments({ person_id, role_id, ranges }, owner)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['positions'] })
      await client.invalidateQueries({ queryKey: RAIL_KEY })
      await client.invalidateQueries({ queryKey: ['org'] })
      onDone()
    },
  })
  const error =
    add.error === null
      ? undefined
      : add.error instanceof ApiClientError
        ? add.error.message
        : t('error.generic')

  return (
    <div
      className="my-1 ml-5 flex flex-col gap-2 rounded-[10px] border border-ws-line bg-ws-card p-2"
      data-testid="rail-add-duty"
      ref={box}
    >
      {template !== undefined && roles.data !== undefined && choices.length === 0 ? (
        <p className="text-[12px] text-ws-muted-fg">{t('rail.add_duty.none')}</p>
      ) : (
        <fieldset className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
          {choices.map((r) => {
            const on = picked.includes(r.id)
            return (
              <button
                key={r.id}
                type="button"
                aria-pressed={on}
                data-testid="rail-add-duty-role"
                data-role={r.id}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors hover:bg-muted',
                  on && 'border-primary bg-primary/10',
                )}
                onClick={() => {
                  setPicked((list) => (on ? list.filter((x) => x !== r.id) : [...list, r.id]))
                }}
              >
                {lang === 'en' && r.name_en !== '' ? r.name_en : r.name}
              </button>
            )
          })}
        </fieldset>
      )}
      {error === undefined ? null : (
        <p role="alert" className="text-[12px] text-destructive">
          {t('rail.error', { msg: error })}
        </p>
      )}
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {t('rail.cancel')}
        </Button>
        <Button
          type="button"
          size="xs"
          data-testid="rail-add-duty-save"
          disabled={picked.length === 0 || template === undefined || add.isPending}
          onClick={() => {
            add.mutate()
          }}
        >
          {t('rail.add')}
        </Button>
      </div>
    </div>
  )
}
