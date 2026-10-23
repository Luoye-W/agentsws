/**
 * WP496 对拍用的本机假页面（人名、数字、链接全是编的；`*.example` 域名）。主页 / 内容页 / 链接页在这个目录，
 * 列表页借 `../lists/` 那几张（WP130 时随私有插件一起写的夹具）。`url` 是这张假页面冒充的地址。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakePage {
  /** 一个短名字（测试名、截图名、真 ego 跑的路径都用它）。 */
  name: string
  file: string
  url: string
  kind: 'creator' | 'content' | 'bio_link' | 'list'
}

const PAGES_DIR = join(process.cwd(), 'test/fixtures/pages')
const LISTS_DIR = join(process.cwd(), 'test/fixtures/lists')

export const FAKE_PAGES: readonly FakePage[] = [
  { name: 'youtube-channel', file: 'pages/youtube-channel.html', url: 'https://www.youtube.com/@deskfixture/videos', kind: 'creator' },
  { name: 'youtube-channel-reveal', file: 'pages/youtube-channel-reveal.html', url: 'https://www.youtube.com/@cablefixture', kind: 'creator' },
  { name: 'tiktok-profile', file: 'pages/tiktok-profile.html', url: 'https://www.tiktok.com/@lunchfixture', kind: 'creator' },
  { name: 'instagram-profile', file: 'pages/instagram-profile.html', url: 'https://www.instagram.com/clayfixture/', kind: 'creator' },
  { name: 'youtube-video', file: 'pages/youtube-video.html', url: 'https://www.youtube.com/watch?v=dfVid000001', kind: 'content' },
  { name: 'youtube-watch-related', file: 'lists/youtube-watch.html', url: 'https://www.youtube.com/watch?v=SeedVideo01&list=PL1&t=42s', kind: 'list' },
  { name: 'tiktok-video', file: 'pages/tiktok-video.html', url: 'https://www.tiktok.com/@lunchfixture/video/7000000000000000209', kind: 'content' },
  { name: 'instagram-post', file: 'pages/instagram-post.html', url: 'https://www.instagram.com/clayfixture/p/CFixtureP07/', kind: 'content' },
  { name: 'linktree', file: 'pages/linktree.html', url: 'https://linktr.ee/deskfixture', kind: 'bio_link' },
  { name: 'youtube-search', file: 'lists/youtube-search.html', url: 'https://www.youtube.com/results?search_query=standing+desk', kind: 'list' },
  { name: 'tiktok-search', file: 'lists/tiktok-search.html', url: 'https://www.tiktok.com/search?q=meal%20prep', kind: 'list' },
  { name: 'tiktok-tag', file: 'lists/tiktok-tag.html', url: 'https://www.tiktok.com/tag/mealprep', kind: 'list' },
  { name: 'instagram-tag', file: 'lists/instagram-tag.html', url: 'https://www.instagram.com/explore/tags/mealprep/', kind: 'list' },
  { name: 'instagram-search', file: 'lists/instagram-search.html', url: 'https://www.instagram.com/explore/search/keyword/?q=mealprep', kind: 'list' },
]

export function fakePageHtml(page: FakePage): string {
  const [dir, file] = page.file.split('/') as [string, string]
  return readFileSync(join(dir === 'pages' ? PAGES_DIR : LISTS_DIR, file), 'utf8')
}
