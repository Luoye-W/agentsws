/**
 * WP234（docs/54 §6.4）：公司页岗位卡上的「合并到… / 拆出… / 移动职责」。
 *
 * 与首次设置第 ③ 步同一套规则（服务端 `org` 端口里做）：合并时职责、事项、岗位层记忆都跟过去；
 * 移动 / 拆出时只动走那条职责的事项，岗位层记忆留在原岗位。说明进问号（界面少字）。
 *
 * WP235：只出现在「你们的岗位」上，作用在**真在做的那几条职责**上（模板只算有人做的），
 * 目标也只列「你们的岗位」。合并时可以给合并后的岗位起名（预填按职责建议，如「Reddit 运营」）。
 *
 * WP456-T6（WP456 §3.8）：设置 → 岗位与职责里这三个入口进了岗位行的「⋯」——那边给 `mode` + `onModeChange`
 * （受控），这里就不画自己那一排按钮，只画选中那一种的小表单。
 */
import { useEffect, useState } from 'react'
import { PickToggle } from '@/components/onboarding/pick-toggle'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import type { OrgPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { dutiesInUse, suggestMergedName } from '@/lib/org-positions'

export type ReshapeMode = 'merge' | 'split' | 'move'
type Mode = ReshapeMode

const SELECT = 'h-8 rounded-md border bg-background px-2 text-sm'
/** 三张小表单的底：浅灰内块（不加边框）。 */
const FORM = 'rounded-lg bg-ws-surface p-3'

/** 这个岗位能做哪几样（只有底座职责的「普通成员」没东西可并；少于两条拆不了）。 */
export function reshapeModes(position: OrgPositionView, others: OrgPositionView[]): ReshapeMode[] {
  const duties = dutiesInUse(position)
  const out: ReshapeMode[] = []
  if (others.length > 0 && duties.length > 0) out.push('merge')
  if (duties.length >= 2) out.push('split')
  if (others.length > 0 && duties.length > 0) out.push('move')
  return out
}

export function PositionReshape({
  position,
  others,
  busy,
  onMerge,
  onMoveDuty,
  onSplit,
  mode: controlled,
  onModeChange,
}: {
  position: OrgPositionView
  /** 能合并 / 移过去的别的岗位（WP235：只是「你们的岗位」，不含它自己）。 */
  others: OrgPositionView[]
  busy: boolean
  /** `name`：合并后那个岗位叫什么。 */
  onMerge(into: string, name: string): void
  onMoveDuty(role_id: string, to: string): void
  onSplit(input: { name: string; role_ids: string[] }): void
  /** WP456-T6：受控——入口在外面（「⋯」里），这里只画表单。 */
  mode?: ReshapeMode | undefined
  onModeChange?(mode: ReshapeMode | undefined): void
}): React.ReactNode {
  const { t, lang } = useApp()
  const [own, setOwn] = useState<Mode | undefined>(undefined)
  const isControlled = onModeChange !== undefined
  const mode = isControlled ? controlled : own
  const setMode = (next: Mode | undefined): void => {
    if (isControlled) onModeChange(next)
    else setOwn(next)
  }
  const [target, setTarget] = useState('')
  const [duty, setDuty] = useState('')
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const duties = dutiesInUse(position)
  const suggest = (id: string): string => {
    const into = others.find((o) => o.id === id)
    return into === undefined ? '' : suggestMergedName(position, into, lang === 'en' ? 'en' : 'zh')
  }
  const reset = (next: Mode | undefined): void => {
    const first = others[0]?.id ?? ''
    setTarget(first)
    setDuty(duties[0]?.role_id ?? '')
    setName(next === 'merge' ? suggest(first) : '')
    setPicked([])
  }
  const open = (next: Mode): void => {
    setMode(mode === next ? undefined : next)
    reset(next)
  }
  // 受控时入口在外面：换了一种就把表单清成那一种的预填
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在外面换了模式时重填，别的变化不该冲掉正在填的
  useEffect(() => {
    if (isControlled) reset(controlled)
  }, [controlled, isControlled])
  const done = (): void => {
    setMode(undefined)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="position-reshape">
      {isControlled ? null : (
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
      )}

      {mode === 'merge' ? (
        <div
          className={`flex flex-wrap items-center gap-2 ${FORM}`}
          data-testid="position-merge-form"
        >
          <span className="text-xs text-ws-muted-fg">{t('org.positions.merge.into')}</span>
          <select
            aria-label={t('org.positions.merge.into')}
            data-testid="position-merge-target"
            className={SELECT}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
              setName(suggest(e.target.value))
            }}
          >
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <Input
            aria-label={t('org.positions.merge.name')}
            placeholder={t('org.positions.merge.name')}
            data-testid="position-merge-name"
            className="h-8 max-w-48"
            maxLength={64}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
            }}
          />
          <Button
            size="sm"
            data-testid="position-merge-go"
            disabled={busy || target === '' || name.trim() === ''}
            onClick={() => {
              onMerge(target, name.trim())
              done()
            }}
          >
            {t('org.positions.merge.go')}
          </Button>
        </div>
      ) : null}

      {mode === 'split' ? (
        <div className={`flex flex-col gap-2 ${FORM}`} data-testid="position-split-form">
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
          className={`flex flex-wrap items-center gap-2 ${FORM}`}
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
          <span className="text-xs text-ws-muted-fg">→</span>
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
