/**
 * 我的 profile 与公开级别（41 §1.3）。
 *
 * 那张表就是这张表单：一行一个字段，一行三个单选（仅本人 / 同事可见 / 全工作区）。
 * "日程明细"那一行**没有第三格**——41 §1.3 里它最高只到同事可见，服务端也会再收一次。
 *
 * 表格底下写清楚：私有待办、个人记忆、对话正文永远只有本人看得到，不在这张表里
 * ——它们不是一个可以调的旋钮。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type DisclosureLevel,
  type MyProfile,
  PROFILE_FIELDS,
  type ProfileFieldName,
  updateMyProfile,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

const LEVELS: DisclosureLevel[] = ['self', 'colleagues', 'workspace']

/** 41 §1.3：日程明细那一行没有"全工作区"这一格。 */
const CEILING: Partial<Record<ProfileFieldName, DisclosureLevel>> = { agenda_detail: 'colleagues' }

const levelsFor = (field: ProfileFieldName): DisclosureLevel[] =>
  CEILING[field] === 'colleagues' ? ['self', 'colleagues'] : LEVELS

export function ProfileForm({
  profile,
  onSaved,
}: {
  profile: MyProfile
  onSaved?: (next: MyProfile) => void
}): React.ReactNode {
  const { t } = useApp()
  const [disclosure, setDisclosure] = useState(profile.disclosure)
  const [minutes, setMinutes] = useState(String(profile.availability.default_minutes))
  const [prefer, setPrefer] = useState(profile.contact_policy.prefer)
  const [skill, setSkill] = useState('')
  const [skills, setSkills] = useState(profile.skills)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: () =>
      updateMyProfile({
        disclosure,
        contact_policy: { prefer },
        availability: { default_minutes: Number(minutes) || profile.availability.default_minutes },
        skills,
      }),
    onSuccess: (next) => {
      setSaved(true)
      onSaved?.(next)
    },
  })

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="profile-form">
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">{t('secretary.profile.positions')}</span>
        <div className="flex flex-wrap gap-1.5">
          {profile.positions.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            profile.positions.map((p) => (
              <Badge key={p.position_id} variant="secondary">
                {p.role_name}
              </Badge>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">{t('secretary.profile.ranges')}</span>
        <span>
          {profile.ranges.length === 0
            ? '—'
            : profile.ranges.map((r) => `${r.kind} ${r.id}`).join('、')}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">{t('secretary.profile.skills')}</span>
        {skills.length === 0 ? (
          <span className="text-muted-foreground">{t('secretary.profile.skills.empty')}</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {skills.map((s) => (
              <Badge key={s.name} variant={s.source === 'self' ? 'default' : 'secondary'}>
                {s.name}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="skill-add">{t('secretary.profile.skills.add')}</Label>
            <Input
              id="skill-add"
              data-testid="skill-add"
              value={skill}
              onChange={(e) => {
                setSkill(e.target.value)
              }}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={skill.trim() === ''}
            onClick={() => {
              setSkills([...skills, { name: skill.trim(), source: 'self' }])
              setSkill('')
              setSaved(false)
            }}
          >
            +
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meet-minutes">{t('secretary.profile.availability')}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="meet-minutes"
            data-testid="meet-minutes"
            type="number"
            className="w-24"
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value)
              setSaved(false)
            }}
          />
          <span className="text-muted-foreground text-xs">
            {t('secretary.profile.availability.hint', { n: minutes })}
          </span>
        </div>
        <span className="text-muted-foreground text-xs">
          {profile.availability.rules
            .map((r) => `${r.days.map((d) => d).join('')} ${r.from}–${r.to}`)
            .join('；')}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="contact-prefer">{t('secretary.profile.contact')}</Label>
        <select
          id="contact-prefer"
          data-testid="contact-prefer"
          className="h-9 w-56 rounded-md border bg-background px-2 text-sm"
          value={prefer}
          onChange={(e) => {
            setPrefer(e.target.value as 'secretary' | 'direct')
            setSaved(false)
          }}
        >
          <option value="secretary">{t('secretary.profile.contact.secretary')}</option>
          <option value="direct">{t('secretary.profile.contact.direct')}</option>
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium">{t('secretary.profile.disclosure')}</span>
        <table className="w-full text-left">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th scope="col" className="py-1 font-normal">
                {t('secretary.profile.disclosure')}
              </th>
              {LEVELS.map((l) => (
                <th key={l} scope="col" className="py-1 font-normal">
                  {t(`secretary.level.${l}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PROFILE_FIELDS.map((field) => (
              <tr key={field} data-testid="disclosure-row" data-field={field}>
                <th scope="row" className="py-1 font-normal">
                  {t(`secretary.field.${field}`)}
                </th>
                {LEVELS.map((level) => (
                  <td key={level} className="py-1">
                    {levelsFor(field).includes(level) ? (
                      <input
                        type="radio"
                        name={`disclosure-${field}`}
                        aria-label={`${t(`secretary.field.${field}`)} ${t(`secretary.level.${level}`)}`}
                        checked={disclosure[field] === level}
                        onChange={() => {
                          setDisclosure({ ...disclosure, [field]: level })
                          setSaved(false)
                        }}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground text-xs">{t('secretary.profile.disclosure.hint')}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          data-testid="profile-save"
          disabled={save.isPending}
          onClick={() => {
            save.mutate()
          }}
        >
          {t('secretary.profile.save')}
        </Button>
        {saved ? (
          <span className="text-muted-foreground text-xs" data-testid="profile-saved">
            {t('secretary.profile.saved')}
          </span>
        ) : null}
        {save.error === null || save.error === undefined ? null : (
          <span role="alert" className="text-destructive text-xs">
            {save.error instanceof Error ? save.error.message : String(save.error)}
          </span>
        )}
      </div>
    </div>
  )
}
