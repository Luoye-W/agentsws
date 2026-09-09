/**
 * 不经模型的**原生表单**（13 §4.3 第二道措施）。
 *
 * 三条纪律写在代码里，不只是写在文档里：
 * 1. 用浏览器原生 `<form>` + `FormData` 收集，值不进 React state、不进任何全局变量；
 * 2. 秘密字段一律 `type="password"` + `autoComplete="off"` + `spellCheck={false}`，
 *    并且 `data-1p-ignore`（不让密码管理器把它当登录框）；
 * 3. 提交只打 `/v1/connections/:service/submit` 这一条路，提交完立刻
 *    `form.reset()`——DOM 里也不留。全程没有一次 `console.*`。
 */

import { ShieldCheck } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProviderFieldSpec } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SecureForm({
  service,
  fields,
  busy,
  onCancel,
  onSubmit,
}: {
  service: string
  fields: ProviderFieldSpec[]
  busy: boolean
  onCancel: () => void
  /** 唯一出口：值只在这一次调用里存在。 */
  onSubmit: (values: Record<string, string>) => void
}): React.ReactNode {
  const { t } = useApp()
  const prefix = useId()
  const [aliasEmpty, setAliasEmpty] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const values: Record<string, string> = {}
    for (const field of fields) {
      const raw = data.get(field.name)
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (value !== '') values[field.name] = value
    }
    const missing = fields.filter((f) => f.required && values[f.name] === undefined)
    if (missing.length > 0) {
      setAliasEmpty(true)
      // 交给浏览器自己报"这是必填项"，不自造一套校验文案
      form.reportValidity()
      return
    }
    setAliasEmpty(false)
    onSubmit(values)
    // 值发出去之后连 DOM 里也不留
    form.reset()
  }

  return (
    <form
      data-testid="secure-form"
      data-service={service}
      className="mt-3 flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={submit}
      autoComplete="off"
      noValidate={false}
    >
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{t('connections.never_ai')}</span>
      </p>
      {fields.map((field) => {
        const id = `${prefix}-${field.name}`
        return (
          <div key={field.name} className="flex flex-col gap-1">
            <Label htmlFor={id} className="text-xs">
              {field.label}
              {field.required ? (
                <span className="text-destructive" title={t('connections.field.required')}>
                  *<span className="sr-only">{t('connections.field.required')}</span>
                </span>
              ) : (
                <span className="text-xs font-normal text-muted-foreground/70">
                  （{t('connections.field.optional')}）
                </span>
              )}
            </Label>
            <Input
              id={id}
              name={field.name}
              // 秘密字段永远是 password 输入框，浏览器不会记、不会自动填
              type={field.secret ? 'password' : (field.kind ?? 'text')}
              required={field.required}
              autoComplete="off"
              spellCheck={false}
              data-secret={field.secret ? 'true' : 'false'}
              data-1p-ignore={field.secret ? 'true' : undefined}
              {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
              {...(field.secret || field.default === undefined
                ? {}
                : { defaultValue: field.default })}
            />
            {field.hint === undefined ? null : (
              <p className="text-[11px] text-muted-foreground">{field.hint}</p>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('connections.saving') : t('connections.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          {t('connections.cancel')}
        </Button>
        {aliasEmpty ? <span className="sr-only">missing required field</span> : null}
      </div>
    </form>
  )
}
