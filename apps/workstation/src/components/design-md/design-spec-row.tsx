/**
 * 品牌档案卡上的那一行「设计规范」（71 §4 最后一句，WP122）。
 *
 * **它自己取数。** 品牌档案卡（WP121）是一个纯展示组件，它的入参里没有设计
 * 规范这一格，而 WP121b 正在重写它所在的那个向导——给它加一个必填的 prop
 * 等于把两个人的改动焊在一起。这一行自己查自己要的东西，卡片那边只多一行
 * `<DesignSpecRow />`。
 *
 * **查不到就整行不出现**（不是显示一个「0 色」）：向导第 ② 步刚跑完分析时，
 * 设计规范那一轮还没跑过是常态。一行「已抓到 0 色」会让用户以为出了错。
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { designSummary } from '@/components/design-md/tokens-view'
import { getBrandDesign } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function DesignSpecRow(): React.ReactElement | null {
  const { t } = useApp()
  const doc = useQuery({ queryKey: ['brand-design'], queryFn: getBrandDesign })
  const profile = doc.data?.profile
  if (profile === undefined) return null
  const summary = designSummary(profile)
  if (summary.colors === 0 && summary.fonts === 0) return null

  return (
    <p className="text-xs text-ws-muted-fg" data-testid="intake-design-md">
      {t('design.md.title')}：{t('design.md.summary', summary)}{' '}
      <Link className="text-ws-brand underline" to="/brand-design">
        {t('design.md.upload')}
      </Link>
    </p>
  )
}
