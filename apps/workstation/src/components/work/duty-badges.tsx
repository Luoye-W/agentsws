/**
 * WP70（54 §4）：一个人"在做什么"，**先岗位、后职责**。
 *
 * 人员页与同事 profile 上以前是一串职责徽章（"店铺管理 / 内容与博客 / 邮件营销 /
 * 订单履约"），四个词讲的其实是一件事——他做网站运营。现在先出岗位徽章，职责折在
 * 它下面，点开才看得见；一个岗位只有一条职责时不折叠，直接把那条摆出来。
 *
 * 岗位与职责的对照表用的是工作区自己的岗位清单（`GET /v1/onboarding/positions`：
 * 任何成员都读得到，46 §1 第 ③ 步用的就是它）。取不到就整堆落到「未归岗位」——
 * 界面上少一层归类，但没有一条职责会因此消失。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { DutyFold } from '@/components/ui/duty-fold'
import { listOnboardingPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { groupDutiesByPosition, type PositionRoleSet } from '@/lib/positions'

/** 这个工作区有哪些岗位、各含哪几条职责（归堆用的对照表）。 */
export function useWorkspacePositions(): PositionRoleSet[] {
  const catalog = useQuery({
    queryKey: ['onboarding', 'positions'],
    queryFn: () => listOnboardingPositions(),
    retry: false,
  })
  return (catalog.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    roles: p.roles.map((r) => ({ role_id: r.id })),
  }))
}

export function DutyBadges({
  duties,
  testId = 'duty-badges',
}: {
  duties: { role_id: string; role_name: string }[]
  testId?: string
}): ReactNode {
  const { t } = useApp()
  const groups = groupDutiesByPosition(duties, useWorkspacePositions())
  if (groups.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {groups.map((group) => (
        <div
          key={group.position_id ?? 'loose'}
          className="flex flex-col gap-1"
          data-testid={`${testId}-position`}
          data-position={group.position_id ?? ''}
        >
          <Badge variant={group.name === undefined ? 'outline' : 'secondary'} className="w-fit">
            {group.name ?? t('duty.none_position', { count: group.duties.length })}
          </Badge>
          <DutyFold
            testId={`${testId}-${group.position_id ?? 'loose'}`}
            duties={group.duties.map((d) => ({ id: d.role_id, name: d.role_name }))}
          />
        </div>
      ))}
    </div>
  )
}
