/**
 * WP324（决策 690）：**配置卡**的身体——缺哪几格就出哪几格（下拉 / 文字 / 数字 / 开关），建议值预填好，
 * 一个「保存并接着做」。保存 = 这张卡的决定（`approve` 带 `values`），服务端存好就按原话接着跑。
 *
 * 只收不是秘密的设置：服务端出卡时就拒了秘密格；这里再兜一道——像口令 / 密钥的格子不画（改走连接卡的本机表单）。
 * 出现规则：一件事跑到一半撞上「缺一步设置」才出；已经设好了不出；同一个设置目标同一时间只有一张。
 */
import {
  isSecretLikeSetupKey,
  type SetupField,
  type SetupRequestPayload,
} from '@agentsws/contracts'
import { type FormEvent, type ReactNode, useId, useRef } from 'react'
import { useCardFootActions } from '@/components/deck/card-foot'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApp } from '@/lib/app-context'
import { hasKey } from '@/lib/i18n'

/**
 * WP385：格子的字由服务端给（中文）；界面是英文、表里有这一格的英文（`setup.field.<目标>.<键>`、
 * 占位 `….ph`）就用英文，没有照旧。
 */
export function useFieldText(target: string): (f: SetupField) => {
  label: string
  placeholder?: string
} {
  const { lang, t } = useApp()
  return (f) => {
    const k = `setup.field.${target}.${f.key}`
    const local = lang !== 'zh' && hasKey(lang, k)
    const ph = local && hasKey(lang, `${k}.ph`) ? t(`${k}.ph`) : f.placeholder
    return { label: local ? t(k) : f.label, ...(ph === undefined ? {} : { placeholder: ph }) }
  }
}

function FieldInput({ field, id }: { field: SetupField; id: string }): ReactNode {
  const common = { id, name: field.key, required: field.required }
  if (field.kind === 'select')
    return (
      <select
        {...common}
        defaultValue={field.suggested ?? ''}
        className="h-9 rounded-md border border-ws-line bg-ws-card px-2 text-sm"
      >
        {field.suggested === undefined ? <option value="" /> : null}
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  if (field.kind === 'toggle')
    return (
      <input
        id={id}
        name={field.key}
        type="checkbox"
        value="true"
        defaultChecked={field.suggested === 'true'}
        className="size-4"
      />
    )
  return (
    <Input
      {...common}
      type={field.kind === 'number' ? 'number' : field.kind === 'url' ? 'url' : 'text'}
      autoComplete="off"
      defaultValue={field.suggested ?? ''}
      {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
    />
  )
}

export function SetupFieldsBody({
  payload,
  saving,
  onSave,
}: {
  payload: SetupRequestPayload
  saving: boolean
  onSave: (values: Record<string, string>) => void
}): ReactNode {
  const { t } = useApp()
  const text = useFieldText(payload.target)
  const prefix = useId()
  const fields = payload.fields.filter((f) => !isSecretLikeSetupKey(f.key, f.label))
  const form = useRef<HTMLFormElement>(null)
  // WP478：「保存并接着做」并进卡底那一排（没有卡底时照旧画在表单下面）
  const hosted = useCardFootActions([
    {
      key: 'setup-save',
      label: t('setup.plan.save'),
      primary: true,
      disabled: saving,
      testId: 'setup-fields-save',
      onSelect: () => {
        form.current?.requestSubmit()
      },
    },
  ])
  const submit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const form = e.currentTarget
    if (!form.reportValidity()) return
    const data = new FormData(form)
    const values: Record<string, string> = {}
    for (const f of fields) {
      const raw = data.get(f.key)
      values[f.key] = f.kind === 'toggle' ? String(raw === 'true') : String(raw ?? '').trim()
    }
    onSave(values)
  }
  return (
    <form ref={form} className="flex flex-col gap-2.5" data-testid="setup-fields" onSubmit={submit}>
      {payload.why === '' ? null : <p className="text-sm leading-6 text-ws-body">{payload.why}</p>}
      {fields.map((raw) => {
        const id = `${prefix}-${raw.key}`
        const shown = text(raw)
        const { placeholder: _p, ...rest } = raw
        const f: SetupField = {
          ...rest,
          label: shown.label,
          ...(shown.placeholder === undefined ? {} : { placeholder: shown.placeholder }),
        }
        return (
          <div
            key={f.key}
            className="flex flex-col gap-1"
            data-testid="setup-field"
            data-key={f.key}
          >
            <div className="flex items-center gap-1">
              <Label htmlFor={id} className="text-xs">
                {f.label}
              </Label>
              {f.suggested_why === undefined ? null : (
                <Hint text={t('setup.fields.suggested', { why: f.suggested_why })} />
              )}
            </div>
            <FieldInput field={f} id={id} />
          </div>
        )
      })}
      {hosted ? (
        // 卡底那颗按的是这个（回车照样能交）
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      ) : (
        <div>
          <Button type="submit" size="sm" disabled={saving} data-testid="setup-fields-save">
            {t('setup.plan.save')}
          </Button>
        </div>
      )}
    </form>
  )
}
