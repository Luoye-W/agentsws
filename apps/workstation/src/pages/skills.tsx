/**
 * 技能页（24 §1 §2、38 §2 WP29 的工作台那一项）。
 *
 * 这一页回答三个问题，别的一概不做：
 * 1. 我现在用的是哪个技能、哪一版？
 * 2. 谁改过它？改的是**人写的**还是**学到的**？
 * 3. 还有几条建议等我定？（真正的决定在收件箱的卡片上按，这里只带你过去——
 *    36 §2.1「动作矩阵只有五个」，技能页不另造一套按钮。）
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { SkillCard } from '@/components/skills/skill-card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getSkillProposals, getSkills, setSkillExcluded } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SkillsPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const skills = useQuery({ queryKey: ['skills'], queryFn: getSkills })
  const proposals = useQuery({ queryKey: ['skills', 'proposals'], queryFn: getSkillProposals })

  const exclude = useMutation({
    mutationFn: (input: { name: string; excluded: boolean }) =>
      setSkillExcluded(input.name, input.excluded),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['skills'] })
    },
  })

  if (skills.data === undefined) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('skills.proposals')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(proposals.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('skills.proposals.empty')}</p>
          ) : (
            (proposals.data ?? []).map((p) => (
              <div
                key={p.approval_item_id}
                className="rounded-md border p-3"
                data-proposal={p.skill}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{p.title}</span>
                  <Badge variant="secondary" className="text-[11px]">
                    {t('skills.proposal.hits')} {p.hits}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{p.summary}</p>
                {/* WP43 ③：这条建议「怎么来的」进问号 */}
                {p.quotes.length === 0 ? null : (
                  <Hint
                    className="mt-1"
                    text={`${t('skills.proposal.quotes')}：「${p.quotes[0] ?? ''}」`}
                  />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    navigate('/')
                  }}
                >
                  {t('skills.proposal.open')}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {skills.data.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t('skills.empty')}
          </CardContent>
        </Card>
      ) : (
        skills.data.map((skill) => (
          <SkillCard
            key={skill.name}
            skill={skill}
            onToggleExcluded={(next) => {
              exclude.mutate({ name: skill.name, excluded: next })
            }}
          />
        ))
      )}
    </div>
  )
}
