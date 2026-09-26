/**
 * 写新页面之前先看一眼 SERP：**排前面的是不是对的人群**（文章第 5 步 "kill bad keywords"）。
 *
 * 一半的词是错的：字面上跟你的产品对得上，搜它的人跟你的顾客对不上（"充电宝 招聘"、
 * "charger meaning"）。看的方法很土：数前 10 条里有几条是"买东西的人会看的"（商品、评测、
 * 对比、论坛里问怎么选），有几条是"别的人群"（招聘、百科、论文、下载、维修教程）。
 *
 * 纯规则、同输入同输出；看不出来就判"不是"——宁可少写一页，也不花一周写给错的人。
 */
import type { SeoSerpCheck, SerpItem, SerpResult } from '@agentsws/contracts'

const BUYER_TERMS = [
  'best',
  'review',
  'vs',
  'compare',
  'buy',
  'price',
  'deal',
  'top',
  'guide',
  'which',
  'recommend',
  'worth',
  '推荐',
  '评测',
  '对比',
  '测评',
  '哪个好',
  '怎么选',
  '价格',
  '购买',
  '选购',
]
const OTHER_CROWD_TERMS = [
  'job',
  'jobs',
  'salary',
  'career',
  'hiring',
  'wiki',
  'wikipedia',
  'definition',
  'meaning',
  'pdf',
  'paper',
  'thesis',
  'download',
  'repair manual',
  'lyrics',
  '招聘',
  '百科',
  '论文',
  '下载',
  '是什么意思',
  '维修教程',
  '工资',
]

const has = (text: string, terms: readonly string[]): string | undefined => {
  const t = ` ${text.toLowerCase()} `
  return terms.find((w) => t.includes(w))
}

/** 一条结果是买东西的人会看的吗？（商品卡、论坛里问怎么选、标题 / 摘要带选购词） */
export function buyerItem(item: SerpItem): boolean {
  if (item.type === 'shopping') return true
  const text = `${item.title} ${item.snippet ?? ''}`
  if (has(text, OTHER_CROWD_TERMS) !== undefined) return false
  return item.type === 'forum' || has(text, BUYER_TERMS) !== undefined
}

/**
 * 判人群。前 10 条里买家那一类 ≥ 3 条、并且不少于别的人群 → 是对的人群。
 *
 * `our_domains` 只用来把我们自己那几条排除掉（自己排上了不说明人群对）。
 */
export function judgeSerpCrowd(serp: SerpResult, our_domains: readonly string[]): SeoSerpCheck {
  const ours = new Set(our_domains.map((d) => d.toLowerCase().replace(/^www\./, '')))
  const top = serp.items
    .filter((i) => !ours.has(i.domain.toLowerCase().replace(/^www\./, '')))
    .sort((a, b) => a.position - b.position)
    .slice(0, 10)
  const buyers = top.filter(buyerItem).length
  const others = top.filter(
    (i) => has(`${i.title} ${i.snippet ?? ''}`, OTHER_CROWD_TERMS) !== undefined,
  ).length
  const right = buyers >= 3 && buyers >= others
  const reason = right
    ? `前 ${top.length} 条里 ${buyers} 条是买东西的人会看的（商品、评测、对比、论坛问怎么选）。`
    : top.length === 0
      ? '搜索结果是空的，看不出是谁在搜。'
      : `前 ${top.length} 条里只有 ${buyers} 条是买东西的人会看的${others > 0 ? `，${others} 条是别的人群（招聘、百科、下载之类）` : ''}——这个词不写。`
  return {
    right_crowd: right,
    reason,
    top_domains: [...new Set(top.slice(0, 5).map((i) => i.domain))],
    fetched_at: serp.fetched_at,
    source: serp.source,
  }
}
