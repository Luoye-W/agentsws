/**
 * WP310（docs/99 §5.5）：被引用的站是哪一类——**先查这张内置表**；认不出的是 `other`，
 * O2 再交模型判一次并缓存进 `domain_kinds`（人可改）。我们 / 竞品不在表里：按关注设置里的域名判。
 *
 * 只收「一看就知道」的大站；子域名也算（`old.reddit.com` → 论坛）。Amazon / eBay 这类各国站点
 * 按名字前段认（`amazon.co.uk`、`ebay.de`）。
 */
import type { CitedSiteKind } from '@agentsws/contracts'

type BuiltinKind = Exclude<CitedSiteKind, 'ours' | 'competitor' | 'other'>

/** 域名 → 类型（按后缀认：`a.com` 认 `a.com` 与 `x.a.com`）。 */
export const BUILTIN_SITE_KINDS: Readonly<Record<string, BuiltinKind>> = {
  // 电商平台
  'walmart.com': 'marketplace',
  'target.com': 'marketplace',
  'bestbuy.com': 'marketplace',
  'etsy.com': 'marketplace',
  'aliexpress.com': 'marketplace',
  'alibaba.com': 'marketplace',
  'temu.com': 'marketplace',
  'shein.com': 'marketplace',
  'costco.com': 'marketplace',
  'homedepot.com': 'marketplace',
  'lowes.com': 'marketplace',
  'newegg.com': 'marketplace',
  'wayfair.com': 'marketplace',
  'kohls.com': 'marketplace',
  'macys.com': 'marketplace',
  'rei.com': 'marketplace',
  'bhphotovideo.com': 'marketplace',
  'jd.com': 'marketplace',
  'taobao.com': 'marketplace',
  'tmall.com': 'marketplace',
  'rakuten.com': 'marketplace',
  'rakuten.co.jp': 'marketplace',
  'mercadolibre.com': 'marketplace',
  'otto.de': 'marketplace',
  'zalando.com': 'marketplace',
  'argos.co.uk': 'marketplace',
  'currys.co.uk': 'marketplace',
  // 论坛社区
  'reddit.com': 'forum',
  'redd.it': 'forum',
  'quora.com': 'forum',
  'stackexchange.com': 'forum',
  'stackoverflow.com': 'forum',
  'zhihu.com': 'forum',
  'tieba.baidu.com': 'forum',
  'xiaohongshu.com': 'forum',
  'avsforum.com': 'forum',
  'head-fi.org': 'forum',
  'slickdeals.net': 'forum',
  'trustpilot.com': 'forum',
  'facebook.com': 'forum',
  'x.com': 'forum',
  'twitter.com': 'forum',
  // 视频
  'youtube.com': 'video',
  'youtu.be': 'video',
  'tiktok.com': 'video',
  'vimeo.com': 'video',
  'bilibili.com': 'video',
  'douyin.com': 'video',
  'instagram.com': 'video',
  // 媒体评测 / 百科
  'wikipedia.org': 'media',
  'nytimes.com': 'media',
  'theverge.com': 'media',
  'cnet.com': 'media',
  'techradar.com': 'media',
  'tomsguide.com': 'media',
  'tomshardware.com': 'media',
  'pcmag.com': 'media',
  'wired.com': 'media',
  'engadget.com': 'media',
  'forbes.com': 'media',
  'businessinsider.com': 'media',
  'rtings.com': 'media',
  'consumerreports.org': 'media',
  'goodhousekeeping.com': 'media',
  'outdoorgearlab.com': 'media',
  'zdnet.com': 'media',
  'gizmodo.com': 'media',
  'mashable.com': 'media',
  'digitaltrends.com': 'media',
  'androidauthority.com': 'media',
  '9to5mac.com': 'media',
  'macrumors.com': 'media',
  'usatoday.com': 'media',
  'theguardian.com': 'media',
  'bbc.co.uk': 'media',
  'bbc.com': 'media',
  'cnn.com': 'media',
  'popularmechanics.com': 'media',
  'whathifi.com': 'media',
  'which.co.uk': 'media',
  'stiftung-warentest.de': 'media',
  'chip.de': 'media',
  'smzdm.com': 'media',
}

/** 各国站点同名的电商（`amazon.com`、`amazon.co.uk`、`amazon.de`、`ebay.fr`…）。 */
const MARKETPLACE_ROOTS = ['amazon', 'ebay']

/**
 * 内置表里认得的类型；认不出回 `undefined`（调用方再看是不是我们 / 竞品，都不是就是 `other`）。
 * `host` 要是 `domainOf` 出来的（小写、无 `www.`）。
 */
export function builtinSiteKind(host: string): BuiltinKind | undefined {
  if (host === '') return undefined
  const labels = host.split('.')
  for (let i = 0; i < labels.length - 1; i += 1) {
    const hit = BUILTIN_SITE_KINDS[labels.slice(i).join('.')]
    if (hit !== undefined) return hit
  }
  // amazon.com / amazon.co.uk / smile.amazon.de：「amazon」后面只剩国家域名那一两段
  for (let i = 0; i < labels.length - 1; i += 1) {
    const rest = labels.slice(i + 1)
    if (
      MARKETPLACE_ROOTS.includes(labels[i] ?? '') &&
      rest.length <= 2 &&
      rest.every((l) => l.length <= 3)
    )
      return 'marketplace'
  }
  return undefined
}
