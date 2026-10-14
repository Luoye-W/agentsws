/**
 * WP317（决策 629）：投放**岗位页**上素材流水线的快捷入口（岗位是主入口，docs/54）。
 *
 * 只一行：图标 +「素材流水线」+ 本人持有的那几条（Google / Meta）各一个链接，点进去是职责页上那一块。
 * 本人在这个岗位里没有 Google / Meta 两条职责就不画。
 */
import { Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useApp } from '@/lib/app-context'
import { dutyHref } from '@/lib/duty-href'

const ENTRY_ROLES: readonly { role_id: string; label: string }[] = [
  { role_id: 'ads.google', label: 'Google' },
  { role_id: 'ads.meta', label: 'Meta' },
]

export function AdCreativeEntry({
  duties,
}: {
  duties: readonly { role_id: string; assignment_id: string }[]
}): React.ReactNode {
  const { t } = useApp()
  const links = ENTRY_ROLES.flatMap((r) => {
    const d = duties.find((x) => x.role_id === r.role_id)
    return d === undefined ? [] : [{ ...r, href: dutyHref(d.assignment_id, r.role_id) }]
  })
  if (links.length === 0) return null
  return (
    <div className="mb-3 flex items-center gap-2 text-sm" data-testid="ad-creative-entry">
      <Sparkles className="size-4 text-muted-foreground" aria-hidden />
      <span>{t('ads.creative.title')}</span>
      {links.map((l) => (
        <Link
          key={l.role_id}
          to={l.href}
          className="rounded-md bg-card px-2 py-0.5 text-xs font-medium shadow-xs hover:bg-accent"
        >
          {l.label}
        </Link>
      ))}
    </div>
  )
}
