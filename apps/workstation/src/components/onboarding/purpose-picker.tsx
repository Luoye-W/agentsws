/**
 * WP142（Fable 定，docs/78 §1 #7）：向导第 ③ 步顶上那一问——「你这次主要想让它干什么」。
 *
 * 几个钮：红人营销 / 客服 / B2B（WP171）/ 都要。「都要」= 红人营销 + 客服一下按齐的捷径，
 * **不含 B2B**（Fable 终审：做独立站的人按「都要」不该多出一个 B2B 岗位，B2B 要明确按那一项）。
 * 这台机器上没装的岗位不问（`availablePurposes`）。
 * 按下去就改下面的岗位勾选（`applyPurposes`），所以用户看得见这一问的后果；
 * 下面的岗位照常能改，这一问不锁任何东西。
 *
 * 为什么不放进 `RolePicker`：它是"这次想干什么"，不是"勾哪个岗位"，
 * 两件事放在同一个容器里，读屏与走查都会把三个目的钮当成三个岗位。
 */
import { PickToggle } from '@/components/onboarding/pick-toggle'
import {
  BOTH_PURPOSES,
  type Purpose,
  toggleBoth,
} from '@/components/onboarding/preset-roles'
import { useApp } from '@/lib/app-context'

export function PurposePicker({
  available,
  value,
  onChange,
}: {
  /** 这台机器上装了的那几个（没装红人营销就不问红人）。 */
  available: readonly Purpose[]
  value: readonly Purpose[]
  onChange(next: Purpose[]): void
}): React.ReactNode {
  const { t } = useApp()
  if (available.length === 0) return null
  // WP171（Fable 终审）：「都要」只管红人与客服两项，B2B 要单独按
  const bothSet = BOTH_PURPOSES.filter((p) => available.includes(p))
  const both = bothSet.length > 1 && bothSet.every((p) => value.includes(p))
  const toggle = (p: Purpose): void => {
    onChange(value.includes(p) ? value.filter((v) => v !== p) : [...value, p])
  }
  return (
    <section className="flex flex-col gap-2 text-sm" data-testid="onboarding-purpose">
      <p className="font-medium">{t('onboarding.purpose.title')}</p>
      <div className="flex flex-wrap gap-2">
        {available.map((p) => (
          <PickToggle
            key={p}
            checked={value.includes(p)}
            testId={`onboarding-purpose-${p}`}
            onToggle={() => {
              toggle(p)
            }}
          >
            {t(`onboarding.purpose.${p}`)}
          </PickToggle>
        ))}
        {bothSet.length > 1 ? (
          <PickToggle
            checked={both}
            testId="onboarding-purpose-both"
            onToggle={() => {
              onChange(toggleBoth(value, available))
            }}
          >
            {t('onboarding.purpose.both')}
          </PickToggle>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('onboarding.purpose.hint')}</p>
    </section>
  )
}
