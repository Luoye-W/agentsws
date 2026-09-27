/**
 * WP158：Search Console / GA4 **连上了、还没选**时那张小卡——一句话 + 下拉 + 一个按钮。
 *
 * 这是要人拍板的（一个 Google 账号底下常有好几个站点 / 媒体资源，选错了读的就是别人的数），
 * 所以是一张卡；其余时候（没连、已经选好）一个像素都不画。选了立刻重读，并刷新面板。
 *
 * 读不到时（没有内容域的职责打开这一页）同样什么都不画：选择器只属于「内容与搜索」。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getGoogleSources, setGoogleSources } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function GoogleSourcePicker({
  assignment,
  source,
}: {
  assignment: string
  source: 'gsc' | 'ga4'
}): React.ReactNode {
  const { t } = useApp()
  const qc = useQueryClient()
  const view = useQuery({
    queryKey: ['google-sources', assignment],
    queryFn: () => getGoogleSources(assignment),
    retry: false,
  })
  const [choice, setChoice] = useState('')
  const save = useMutation({
    mutationFn: (id: string) =>
      setGoogleSources(source === 'gsc' ? { gsc_site: id } : { ga4_property: id }, assignment),
    onSuccess: (data) => {
      qc.setQueryData(['google-sources', assignment], data)
      void qc.invalidateQueries({ queryKey: ['view'] })
    },
  })

  const part = view.data?.[source]
  if (part === undefined || !part.connected) return null
  if (!part.needs_pick) {
    // 选好了：只在上一次没读到时留一行状态（服务端写好的那句人话）
    return part.note === undefined ? null : (
      <p
        className="text-sm text-muted-foreground"
        role="status"
        data-testid={`google-source-note-${source}`}
      >
        {part.note}
      </p>
    )
  }
  const id = `google-source-${source}`
  return (
    <Card data-testid={`google-source-picker-${source}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Search className="size-4" aria-hidden />
          {t(`seo.pick.${source}.title`)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{t(`seo.pick.${source}.body`)}</p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (choice !== '') save.mutate(choice)
          }}
        >
          <select
            id={id}
            data-testid={id}
            aria-label={t(`seo.pick.${source}.title`)}
            className="h-9 min-w-56 rounded-md border bg-background px-2 text-sm"
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value)
            }}
          >
            <option value="">{t('seo.pick.placeholder')}</option>
            {part.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <Button size="sm" type="submit" disabled={choice === '' || save.isPending}>
            {save.isPending ? t('seo.pick.saving') : t('seo.pick.save')}
          </Button>
        </form>
        {part.note === undefined ? null : (
          <p className="text-sm text-muted-foreground" role="status">
            {part.note}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
