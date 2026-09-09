/** 连接与设置：v1 只做壳 + 主题 / 语言两个真的开关。 */
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
        <p className="text-muted-foreground">{t('settings.placeholder')}</p>
      </CardContent>
    </Card>
  )
}
