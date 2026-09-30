/**
 * WP207：左栏「岗位」标题旁的「+」——**就地**新建一个岗位（名字 + 选职责）。
 *
 * 用的是公司页那一套（同一个接口、同一份职责清单、同一个过滤：拆过的老职责不给新勾，
 * `pickableRoles`）；建完**自动分给自己**（范围不设 = 整个品牌，和向导里不挑范围一样），
 * 然后左栏刷新、这个岗位展开。只有所有者看得到这个「+」（公司页也只有所有者能改）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { railPickable } from '@/components/sidebar/add-duty-inline'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ApiClientError,
  createAssignments,
  createOrgPosition,
  listRoleDefinitions,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'
import { RAIL_KEY } from '@/lib/work-archive'

export function NewPositionInline({
  owner,
  person_id,
  onDone,
  onCancel,
}: {
  /** 所有者那条分配（公司页的写操作一律用它，05 §3）。 */
  owner: string
  person_id: string
  onDone: (position_id: string) => void
  onCancel: () => void
}): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const roles = useQuery({
    queryKey: ['org', 'roles', owner],
    queryFn: () => listRoleDefinitions(owner),
  })
  const create = useMutation({
    mutationFn: async () => {
      const position = await createOrgPosition(
        { name: name.trim(), roles: picked.map((role_id) => ({ role_id, default: true })) },
        owner,
      )
      await createAssignments({ person_id, position_id: position.id, ranges: [] }, owner)
      return position
    },
    onSuccess: async (position) => {
      await client.invalidateQueries({ queryKey: ['positions'] })
      await client.invalidateQueries({ queryKey: RAIL_KEY })
      await client.invalidateQueries({ queryKey: ['org'] })
      onDone(position.id)
    },
  })
  const error =
    create.error === null
      ? undefined
      : create.error instanceof ApiClientError
        ? create.error.message
        : t('error.generic')

  return (
    <form
      className="mx-1 mb-1 flex flex-col gap-2 rounded-[10px] border border-ws-line bg-ws-card p-2"
      data-testid="rail-new-position"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() !== '' && picked.length > 0) create.mutate()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <Input
        ref={input}
        value={name}
        aria-label={t('rail.position.name')}
        placeholder={t('rail.position.name.placeholder')}
        data-testid="rail-new-position-name"
        className="h-7 text-[13px]"
        maxLength={64}
        onChange={(e) => {
          setName(e.target.value)
        }}
      />
      <fieldset className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
        <legend className="mb-1 text-[11px] text-ws-muted-fg">{t('rail.position.pick')}</legend>
        {railPickable(roles.data ?? []).map((r) => {
          const on = picked.includes(r.id)
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={on}
              data-testid="rail-new-position-role"
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
          type="submit"
          size="xs"
          data-testid="rail-new-position-save"
          disabled={name.trim() === '' || picked.length === 0 || create.isPending}
        >
          {t('rail.create')}
        </Button>
      </div>
    </form>
  )
}
