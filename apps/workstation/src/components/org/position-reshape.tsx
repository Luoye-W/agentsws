/**
 * WP234（docs/54 §6.4）：公司页岗位卡上的「合并到… / 拆出… / 移动职责」。
 *
 * 与首次设置第 ③ 步同一套规则（服务端 `org` 端口里做）：合并时职责、事项、岗位层记忆都跟过去；
 * 移动 / 拆出时只动走那条职责的事项，岗位层记忆留在原岗位。说明进问号（界面少字）。
 */
import { useState } from 'react'
import { PickToggle } from '@/components/onboarding/pick-toggle'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { OrgPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Mode = 'merge' | 'split' | 'move'

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm'

export function PositionReshape({
  position,
  others,
  busy,
  onMerge,
  onMoveDuty,
  onSplit,
}: {
  position: OrgPositionView
  /** 能合并 / 移过去的别的岗位（不含「负责人」与它自己）。 */
  others: OrgPositionView[]
  busy: boolean
  onMerge(into: string): void
  onMoveDuty(role_id: string, to: string): void
  onSplit(input: { name: string; role_ids: string[] }): void
}): React.ReactNode {
  const { t } = useApp()
  const [mode, setMode] = useState<Mode | undefined>(undefined)
  const [target, setTarget] = useState('')
  const [duty, setDuty] = useState('')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const duties = position.roles.filter((r) => !r.role_id.startsWith('common.'))
  const open = (next: Mode): void => {
    setMode(mode === next ? undefined : next)
    setTarget(others[0]?.id ?? '')
    setDuty(duties[0]?.role_id ?? '')
    setName('')
    setPicked([])
  }
  const done = (): void => {
    setMode(undefined)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="position-reshape">
      <div className="flex flex-wrap items-center gap-1">
        {/* 只有底座职责的岗位（「普通成员」）没东西可并 */}
        {others.length === 0 || duties.length === 0 ? null : (
          <Button
            size="xs"
            variant="ghost"
            data-testid="position-merge"
            aria-expanded={mode === 'merge'}
            onClick={() => {
              open('merge')
            }}
          >
            {t('org.positions.merge')}
          </Button>
        )}
        {duties.length < 2 ? null : (
          <Button
            size="xs"
            variant="ghost"
            data-testid="position-split"
            aria-expanded={mode === 'split'}
            onClick={() => {
              open('split')
            }}
          >
            {t('org.positions.split')}
          </Button>
        )}
        {others.length === 0 || duties.length === 0 ? null : (
          <Button
            size="xs"
            variant="ghost"
            data-testid="position-move"
            aria-expanded={mode === 'move'}
            onClick={() => {
              open('move')
            }}
          >
            {t('org.positions.move')}
          </Button>
        )}
        <Hint text={t('org.positions.reshape.hint')} />
      </div>

      {mode === 'merge' ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border p-2"
          data-testid="position-merge-form"
        >
          <span className="text-xs text-muted-foreground">{t('org.positions.merge.into')}</span>
          <select
            aria-label={t('org.positions.merge.into')}
            data-testid="position-merge-target"
            className={SELECT}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
            }}
          >
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            data-testid="position-merge-go"
            disabled={busy || target === ''}
            onClick={() => {
              onMerge(target)
              done()
            }}
          >
            {t('org.positions.merge.go')}
          </Button>
        </div>
      ) : null}

      {mode === 'split' ? (
        <div
          className="flex flex-col gap-2 rounded-md border p-2"
          data-testid="position-split-form"
        >
          <Input
            aria-label={t('org.positions.split.name')}
            placeholder={t('org.positions.split.name')}
            data-testid="position-split-name"
            className="h-8 max-w-60"
            maxLength={64}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
          <div className="flex flex-wrap gap-1.5">
            {duties.map((r) => (
              <PickToggle
                key={r.role_id}
                checked={picked.includes(r.role_id)}
                testId="position-split-duty"
                className="inline-flex items-center gap-1 text-xs"
                onToggle={() => {
                  setPicked((cur) =>
                    cur.includes(r.role_id)
                      ? cur.filter((x) => x !== r.role_id)
                      : [...cur, r.role_id],
                  )
                }}
              >
                <DutyIcon role_id={r.role_id} size={13} className="text-ws-muted-fg" />
                {r.name}
              </PickToggle>
            ))}
          </div>
          <div>
            <Button
              size="sm"
              data-testid="position-split-go"
              // 全拆走等于改名，不叫拆
              disabled={
                busy || name.trim() === '' || picked.length === 0 || picked.length >= duties.length
              }
              onClick={() => {
                onSplit({ name: name.trim(), role_ids: picked })
                done()
              }}
            >
              {t('org.positions.split.go')}
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'move' ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border p-2"
          data-testid="position-move-form"
        >
          <select
            aria-label={t('org.positions.move.duty')}
            data-testid="position-move-duty"
            className={SELECT}
            value={duty}
            onChange={(e) => {
              setDuty(e.target.value)
            }}
          >
            {duties.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">→</span>
          <select
            aria-label={t('org.positions.move.to')}
            data-testid="position-move-target"
            className={SELECT}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
            }}
          >
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            data-testid="position-move-go"
            disabled={busy || duty === '' || target === ''}
            onClick={() => {
              onMoveDuty(duty, target)
              done()
            }}
          >
            {t('org.positions.move.go')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
