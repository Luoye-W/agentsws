/**
 * 决策 945：服务开给局域网（NAS）时登录页的那一半。
 *
 * 这一档页面拿不到一次性 token、也拿不到主人邮箱，所以不出「填邮箱 → 一按就进」：
 * - 主人：输入印在服务日志里的一次性设置码，换一张一次性登录 token，交回登录页的「进去」那一步；
 * - 同事：只能走邀请链接（`/invite/:token`），这里只告诉他去找谁要。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, redeemSetupCode } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SharedLoginPanel({
  onToken,
}: {
  /** 设置码对上了：把一次性登录 token 交回登录页（页面上不显示它）。 */
  onToken: (token: string) => void
}): React.ReactNode {
  const { t } = useApp()
  const [code, setCode] = useState('')
  const redeem = useMutation({
    mutationFn: (value: string) => redeemSetupCode(value),
    onSuccess: (issued) => {
      setCode('')
      onToken(issued.token)
    },
  })

  return (
    <div className="flex flex-col gap-3" data-testid="login-shared">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="login-setup-code">
            {t('login.shared.owner')} · {t('login.shared.code')}
          </Label>
          <Hint text={t('login.shared.codeTip')} />
        </div>
        <Input
          id="login-setup-code"
          autoComplete="one-time-code"
          spellCheck={false}
          value={code}
          placeholder="ABCD-EFGH"
          onChange={(e) => {
            setCode(e.target.value)
          }}
        />
      </div>
      <Button
        disabled={code.trim().length < 4 || redeem.isPending}
        onClick={() => {
          redeem.mutate(code.trim())
        }}
      >
        {t('login.shared.submit')}
      </Button>
      {redeem.error === null ? null : (
        <p role="alert" className="text-destructive" data-testid="setup-code-error">
          {redeem.error instanceof ApiClientError ? redeem.error.message : t('error.generic')}
        </p>
      )}
      <p className="text-xs text-muted-foreground" data-testid="login-shared-colleague">
        {t('login.shared.colleague')}
      </p>
    </div>
  )
}
