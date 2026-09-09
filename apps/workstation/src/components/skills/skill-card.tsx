/**
 * 一个技能在技能页上的样子（24 §1 §2）。
 *
 * 三件事要一眼看见：现在是哪一版、三层各改了什么、还有几条建议等你定。
 * 每条改动都标出来源——「人写的」还是「学到的」（06 §3.4 纪律：
 * 自动改的段落在界面上有标记，人随时能看出技能里哪些是自己写的、哪些是学来的）。
 */
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { SkillOverlayView, SkillSummary } from '@/lib/api'
import { useApp } from '@/lib/app-context'

function OriginBadge({ origin }: { origin: 'authored' | 'learned' }): React.ReactNode {
  const { t } = useApp()
  return (
    <Badge
      variant={origin === 'learned' ? 'default' : 'outline'}
      className="text-[11px]"
      data-origin={origin}
    >
      {t(`skills.origin.${origin}`)}
    </Badge>
  )
}

function OverlayRow({ overlay }: { overlay: SkillOverlayView }): React.ReactNode {
  const { t } = useApp()
  return (
    <div className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[11px]">
          {t(`skills.tier.${overlay.tier}`)}
        </Badge>
        <span className="text-xs text-muted-foreground">
          v{overlay.version} · base {overlay.base_version}
        </span>
      </div>
      <ul className="mt-1 space-y-1">
        {overlay.ops.map((op) => (
          <li key={`${op.section_id}-${op.op}`} className="flex items-start gap-2 text-xs">
            <OriginBadge origin={op.origin} />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{op.heading ?? op.section_id}</span>
              {op.body === undefined ? null : (
                <span className="block text-muted-foreground">{op.body}</span>
              )}
              {op.learned_from === undefined ? null : (
                <span className="block text-[11px] text-muted-foreground">
                  {t('skills.learned_from')} · {op.learned_from.at.slice(0, 10)} ·{' '}
                  {op.learned_from.lessons.length}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function SkillCard({
  skill,
  onToggleExcluded,
}: {
  skill: SkillSummary
  onToggleExcluded(next: boolean): void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <Card data-skill={skill.name}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">
          {skill.name}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {t('skills.version')} {skill.version} · {t('skills.base_tier')}{' '}
            {t(`skills.tier.${skill.tier}`)}
          </span>
        </CardTitle>
        <div className="flex items-center gap-2">
          {skill.excluded ? (
            <Badge variant="outline" className="text-[11px]">
              {t('skills.excluded')}
            </Badge>
          ) : null}
          <Badge
            variant={skill.pending_proposals > 0 ? 'default' : 'secondary'}
            className="text-[11px]"
          >
            {skill.pending_proposals > 0
              ? `${t('skills.pending')} ${skill.pending_proposals}`
              : t('skills.pending.zero')}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onToggleExcluded(!skill.excluded)
            }}
          >
            {skill.excluded ? t('skills.include') : t('skills.exclude')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">{t('skills.sections')}</div>
          <ul className="mt-1 flex flex-wrap gap-1">
            {skill.sections.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <Badge variant="outline" className="text-[11px]">
                  {s.heading}
                </Badge>
                {s.origin === 'learned' ? <OriginBadge origin="learned" /> : null}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{t('skills.overlays')}</div>
          {skill.overlays.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('skills.overlay.none')}</p>
          ) : (
            <div className="mt-1 space-y-2">
              {skill.overlays.map((o) => (
                <OverlayRow key={`${o.tier}-${o.owner}`} overlay={o} />
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
