/**
 * WP276（docs/95 §2.8「两套邀请合一」）：同事点**邀请链接**进来的那一页。
 *
 * 链接就是带着邀请码的申请：填称呼与邮箱 → 申请一起用 → 这边任何一位同事同意 → 用这个邮箱登录。
 * 与贴码是同一套规矩（申请 → 有人同意），不再是「点了就成了成员」。这一页不需要会话。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BrandMark } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, requestMembership } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function JoinByCodePage(): React.ReactNode {
  const { t } = useApp()
  const code = (useParams().code ?? '').toUpperCase()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const send = useMutation({ mutationFn: () => requestMembership({ code, name, email }) })
  const bad = send.error instanceof ApiClientError && send.error.status === 404
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm" data-testid="join-code">
        <CardHeader className="flex flex-col items-center gap-3">
          <BrandMark size={40} />
          <CardTitle className="text-base">{t('joincode.title')}</CardTitle>
          <p className="font-mono text-sm tracking-widest text-muted-foreground">{code}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {send.isSuccess ? (
            <>
              <p data-testid="join-code-sent">{t('joincode.sent')}</p>
              <Link to="/login" className="text-xs underline-offset-2 hover:underline">
                {t('login.title')}
              </Link>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                send.mutate()
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor="join-code-name">{t('joincode.name')}</Label>
                <Input
                  id="join-code-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="join-code-email">{t('joincode.email')}</Label>
                <Input
                  id="join-code-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                  }}
                />
              </div>
              {send.error === null ? null : (
                <p role="alert" className="text-xs text-destructive">
                  {bad ? t('joincode.bad') : send.error.message}
                </p>
              )}
              <Button
                type="submit"
                disabled={send.isPending || name.trim() === '' || email.trim() === ''}
              >
                {t('joincode.submit')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
