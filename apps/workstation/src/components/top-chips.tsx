/**
 * WP71（36 §10）：顶栏剩下的两个芯片——**现在用哪个模型**、**还剩多少积分**。
 *
 * 两条都遵同一个规矩：**问不到就不出**。没配模型、没关联云账号、接口打不通——
 * 一律整块不渲染，而不是显示"—"或者 0。顶栏上的一个数字如果可能是编的，
 * 它就不该在顶栏上（36 §3 原则 ③：一眼看完的核心数字，数不出来就别占位）。
 */
import { useQuery } from '@tanstack/react-query'
import { Coins, Cpu } from 'lucide-react'
import { Link } from 'react-router-dom'
import { getCloudCredits, getModelDefaults } from '@/lib/api'
import { useApp } from '@/lib/app-context'

function Chip({
  to,
  icon: Icon,
  label,
  title,
  testId,
}: {
  to: string
  icon: typeof Cpu
  label: string
  title: string
  testId: string
}): React.ReactNode {
  return (
    <Link
      to={to}
      title={title}
      data-testid={testId}
      className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="max-w-32 truncate tabular-nums">{label}</span>
    </Link>
  )
}

export function ModelChip(): React.ReactNode {
  const { t } = useApp()
  const defaults = useQuery({
    queryKey: ['models', 'defaults'],
    queryFn: () => getModelDefaults(),
    retry: false,
  })
  const model = defaults.data?.default
  if (model === undefined || model === '') return null
  return (
    <Chip
      to="/settings?tab=models"
      icon={Cpu}
      label={model}
      title={t('topbar.model', { model })}
      testId="model-chip"
    />
  )
}

export function CreditsChip(): React.ReactNode {
  const { t } = useApp()
  const credits = useQuery({
    queryKey: ['cloud-credits', 'chip'],
    queryFn: () => getCloudCredits(),
    retry: false,
  })
  const available = credits.data?.linked === true ? credits.data.balance?.available : undefined
  if (available === undefined) return null
  return (
    <Chip
      to="/settings?tab=account"
      icon={Coins}
      label={available.toLocaleString()}
      title={t('topbar.credits')}
      testId="credits-chip"
    />
  )
}
