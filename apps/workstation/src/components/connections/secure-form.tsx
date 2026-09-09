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

import { ShieldCheck, Wand2 } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { detectMailbox, type MailboxPresetView, type ProviderFieldSpec } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SecureForm({
  service,
  fields,
  busy,
  assignment,
  onCancel,
  onSubmit,
}: {
  service: string
  fields: ProviderFieldSpec[]
  busy: boolean
  /** 识别请求要带的岗位（连接是所有者的事）。 */
  assignment?: string
  onCancel: () => void
  /** 唯一出口：值只在这一次调用里存在。 */
  onSubmit: (values: Record<string, string>) => void
}): React.ReactNode {
  const { t } = useApp()
  const prefix = useId()
  const [aliasEmpty, setAliasEmpty] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  /** WP25 交付 B：认出来是哪家邮箱（只影响主机端口这几个**非秘密**字段）。 */
  const [preset, setPreset] = useState<MailboxPresetView | null>(null)
  const [detecting, setDetecting] = useState(false)

  /**
   * 邮箱地址填完（失焦）→ 查一次 MX → 把主机端口填好。
   *
   * 只碰四个非秘密字段，而且**只在用户还没自己填过**的时候填（不覆盖手填的值）。
   * 这个调用失败一律静默：识别不到就让用户手填，绝不打断填表。
   */
  const detect = (email: string): void => {
    const form = formRef.current
    if (form === null || !email.includes('@')) return
    setDetecting(true)
    void detectMailbox(email, assignment)
      .then((found) => {
        setPreset(found.preset)
        if (found.preset === null) return
        const fill = (name: string, value: string): void => {
          const input = form.elements.namedItem(name)
          if (input instanceof HTMLInputElement && input.value.trim() === '') input.value = value
        }
        fill('imap_host', found.preset.imap_host)
        fill('imap_port', String(found.preset.imap_port))
        fill('smtp_host', found.preset.smtp_host)
        fill('smtp_port', String(found.preset.smtp_port))
      })
      .catch(() => {
        // 认不出来就手填——这条路上什么都不该炸
        setPreset(null)
      })
      .finally(() => {
        setDetecting(false)
      })
  }

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
      ref={formRef}
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
      {preset === null ? null : (
        <p
          className={
            preset.auth === 'oauth_required'
              ? 'flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs'
              : 'flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-xs'
          }
          data-testid="mail-preset"
          data-preset={preset.id}
          data-auth={preset.auth}
        >
          <Wand2 className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">
              {t('connections.mail.detected')} {preset.label}
            </span>
            <span className="ml-1 text-muted-foreground">{preset.note}</span>
            {preset.help_url === undefined ? null : (
              <a
                href={preset.help_url}
                target="_blank"
                rel="noreferrer noopener"
                className="ml-1 text-primary underline-offset-4 hover:underline"
              >
                {t('connections.mail.how')}
              </a>
            )}
          </span>
        </p>
      )}
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
              {...(field.kind === 'email'
                ? {
                    onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
                      detect(event.currentTarget.value.trim())
                    },
                  }
                : {})}
            />
            {field.kind === 'email' && detecting ? (
              <p className="text-[11px] text-muted-foreground" data-testid="mail-detecting">
                {t('connections.mail.detecting')}
              </p>
            ) : null}
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
