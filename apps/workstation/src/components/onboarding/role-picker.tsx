/**
 * 向导第 ③ 步：你做什么（46 §1 表 ③）。
 *
 * 两条规则写死在这里，**和服务端是同一套**（`expandRoles`）：
 *
 * 1. 勾一个岗位 = 它包含的职责全勾上。所以界面上勾了什么、服务端建了什么不会两张皮。
 * 2. 展开一个岗位可以只勾其中几条——那几条不算"我做这个岗位"，会合成一个自定义岗位。
 *
 * 每条职责后面那个问号就是 46 §1 表里的"它会干什么"（36 §7：解释进 tooltip）。
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { PickToggle } from '@/components/onboarding/pick-toggle'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OnboardingPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface RolePick {
  position_ids: string[]
  /** 单独勾的职责（不含被岗位带上的那些）。 */
  role_ids: string[]
  custom_position_name: string
}

/** 勾了岗位就把它的职责全算上——服务端 `expandRoles` 的前端那一半。 */
export function expandPick(pick: RolePick, positions: OnboardingPositionView[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  for (const id of pick.position_ids) {
    const position = positions.find((p) => p.id === id)
    for (const r of position?.roles ?? []) push(r.id)
  }
  for (const id of pick.role_ids) push(id)
  return out
}

export function RolePicker({
  positions,
  value,
  onChange,
}: {
  positions: OnboardingPositionView[]
  value: RolePick
  onChange(next: RolePick): void
}): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState<string[]>([])
  const expanded = expandPick(value, positions)

  const togglePosition = (id: string): void => {
    const has = value.position_ids.includes(id)
    const nextPositions = has
      ? value.position_ids.filter((p) => p !== id)
      : [...value.position_ids, id]
    // 取消勾选一个岗位时，它带上来的职责一起去掉——**除非**用户在展开里单独勾过。
    // 单独勾过的那些留在 `role_ids` 里，本来就不受岗位勾选影响。
    onChange({ ...value, position_ids: nextPositions })
  }

  const toggleRole = (id: string): void => {
    const has = value.role_ids.includes(id)
    onChange({
      ...value,
      role_ids: has ? value.role_ids.filter((r) => r !== id) : [...value.role_ids, id],
    })
  }

  const toggleOpen = (id: string): void => {
    setOpen((current) =>
      current.includes(id) ? current.filter((o) => o !== id) : [...current, id],
    )
  }

  /** 只勾职责没勾岗位时才问"这个自定义岗位叫什么"（46 §3 I6）。 */
  const loose = value.role_ids.filter(
    (r) =>
      !positions.some((p) => value.position_ids.includes(p.id) && p.roles.some((x) => x.id === r)),
  )

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="onboarding-roles">
      <p className="text-xs text-muted-foreground">{t('onboarding.roles.pick_position')}</p>

      <div className="flex flex-col gap-2">
        {positions.map((p) => {
          const isOpen = open.includes(p.id)
          return (
            <div key={p.id} className="rounded-md border">
              <div className="flex items-center gap-2 p-2">
                <PickToggle
                  checked={value.position_ids.includes(p.id)}
                  testId="onboarding-position"
                  onToggle={() => {
                    togglePosition(p.id)
                  }}
                >
                  {p.name}
                  <span className="ml-1 text-xs text-muted-foreground">{p.roles.length}</span>
                </PickToggle>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="onboarding-expand"
                  aria-expanded={isOpen}
                  onClick={() => {
                    toggleOpen(p.id)
                  }}
                >
                  {isOpen ? (
                    <ChevronDown aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronRight aria-hidden className="size-3.5" />
                  )}
                  {isOpen ? t('onboarding.roles.collapse') : t('onboarding.roles.expand')}
                </button>
              </div>
              {isOpen ? (
                <div className="flex flex-wrap gap-2 border-t p-2">
                  {p.roles.map((r) => (
                    <span key={r.id} className="inline-flex items-center gap-1">
                      <PickToggle
                        checked={expanded.includes(r.id)}
                        // 岗位勾着的时候它的职责就是全勾——再点单条没有意义，
                        // 要只勾几条得先把岗位那一勾取消掉
                        disabled={value.position_ids.includes(p.id)}
                        testId="onboarding-role"
                        onToggle={() => {
                          toggleRole(r.id)
                        }}
                      >
                        {r.name}
                      </PickToggle>
                      <Hint text={r.what_it_does} testId="onboarding-role-hint" />
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {loose.length > 0 ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="onboarding-custom" className="flex items-center gap-1 text-xs">
            {t('onboarding.roles.custom')}
            <Hint text={t('onboarding.roles.custom.hint')} />
          </Label>
          <Input
            id="onboarding-custom"
            data-testid="onboarding-custom"
            value={value.custom_position_name}
            placeholder={t('onboarding.roles.custom.placeholder')}
            onChange={(e) => {
              onChange({ ...value, custom_position_name: e.target.value })
            }}
          />
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground" data-testid="onboarding-role-count">
        {expanded.length === 0
          ? t('onboarding.roles.none')
          : t('onboarding.roles.picked', { n: String(expanded.length) })}
      </p>
    </div>
  )
}
