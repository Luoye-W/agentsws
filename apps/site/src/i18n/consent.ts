/**
 * WP477（决策 1611 选 A）：统计横幅与页脚「统计设置」的文案。界面少字：一句话 + 两个按钮 + 隐私政策链接。
 * 单独一个文件（不进 `common.ts`），免得和改首页文案的分支撞在一起。
 */
import type { Lang } from './common.js'

export const CONSENT: Record<
  Lang,
  {
    title: string
    text: string
    allow: string
    deny: string
    policy: string
    settings: string
    label: string
  }
> = {
  zh: {
    title: '允许我们统计访问吗？',
    text: '我们用 Google Analytics 统计访问量，同意后才存 Cookie。',
    allow: '允许',
    deny: '不允许',
    policy: '隐私政策',
    settings: '统计设置',
    label: '统计设置',
  },
  en: {
    title: 'Help us count visits?',
    text: 'We use Google Analytics to count visits. Cookies are stored only if you agree.',
    allow: 'Allow',
    deny: 'Decline',
    policy: 'Privacy',
    settings: 'Analytics settings',
    label: 'Analytics settings',
  },
}
