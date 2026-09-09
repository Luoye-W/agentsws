/**
 * 设置：这台机器上的偏好——主题、语言、当前身份。
 *
 * WP20 之后，**连接搬到了 `/connections`**（左栏「连接」）：连接要管的东西
 * （凭据、加固状态、试连）与"深色模式"不该挤在一页里。
 */
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { useApp } from '@/lib/app-context'

export function SettingsPage({ identity }: { identity?: string }): React.ReactNode {
  const { t, theme, toggleTheme, lang, setLang } = useApp()
  return (
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
  )
}
