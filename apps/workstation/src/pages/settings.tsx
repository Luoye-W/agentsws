/**
 * 设置：这台机器上的偏好——主题、语言、当前身份，以及 **WP25 新加的「模型」**。
 *
 * WP20 之后，**连接搬到了 `/connections`**（左栏「连接」）：连接要管的东西
 * （凭据、加固状态、试连）与"深色模式"不该挤在一页里。
 *
 * 模型留在这里而不是另开一页：接模型是**一次性的**（填一把 key 就完了），
 * 之后只会偶尔来看一眼花了多少；连接是要长期管的（试连、重新授权、断开）。
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ModelsPanel } from '@/components/models/models-panel'
import { NoModelBanner } from '@/components/models/no-model-banner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function SettingsPage({ identity }: { identity?: string }): React.ReactNode {
  const { t, theme, toggleTheme, lang, setLang } = useApp()
  // 模型 key 与连接凭据同一套权限（05 owner）：这一页显式用所有者那条岗位，
  // 而不是跟着左栏当前选中的岗位走（网关一次请求绑一个 Assignment，31 §3.1）
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id

  return (
    <div className="flex flex-col gap-4">
      <NoModelBanner />
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('settings.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex items-center justify-between">
            <span>{t('settings.theme')}</span>
            <Button size="sm" variant="outline" onClick={toggleTheme}>
              {theme === 'dark' ? t('theme.dark') : t('theme.light')}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span>{t('settings.lang')}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLang(lang === 'zh' ? 'en' : 'zh')
              }}
            >
              {lang === 'zh' ? '中文' : 'English'}
            </Button>
          </div>
          {identity === undefined ? null : (
            <div className="flex items-center justify-between">
              <span>{t('settings.identity')}</span>
              <span className="font-mono text-xs text-muted-foreground">{identity}</span>
            </div>
          )}
          <Separator />
          <p className="text-muted-foreground">
            {t('settings.placeholder')}{' '}
            <Link to="/connections" className="text-primary underline-offset-4 hover:underline">
              {t('nav.connections')}
            </Link>
          </p>
        </CardContent>
      </Card>
      {ownerId === undefined ? null : <ModelsPanel assignment={ownerId} />}
    </div>
  )
}
