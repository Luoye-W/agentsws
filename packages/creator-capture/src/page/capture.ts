/**
 * **在页面里跑**的那一段（WP496，决策 1739 A）：打开着的这一页是谁的主页 / 哪条内容 / 哪张列表 / 哪个链接页，
 * 用插件**同一套采集器**读出来，回一份能 JSON 化的结果。
 *
 * 这个文件是新写的「接线」，不是移植的算法：它按私有插件面板的顺序调采集器，一步不多——
 *
 * | 页面 | 插件那边是谁在调 | 这里调的同一组函数 |
 * |---|---|---|
 * | 主页（YouTube 频道 / TikTok / Instagram） | 主页卡 `readSnapshot`（`CREATOR_SCRAPERS`），YouTube 再补「过完人机验证后弹出来的商务邮箱」 | `readYouTubeChannelSnapshot` / `readTikTokProfileSnapshot` / `readInstagramProfileSnapshot`；`readVerifiedBusinessEmail` |
 * | 内容页（视频 / 帖子） | 内容卡 `CONTENT_SCRAPERS`（带上平台自己打的两个标识） | `readYouTubeWatchSnapshot` / `readTikTokVideoSnapshot` / `readInstagramPostSnapshot` + `withCommerceSignals` |
 * | 列表页（搜索 / hashtag / 视频页右栏） | 列表按钮的那次重扫 + 右栏身份对照 | `collectYouTubeSearchCreators` / `collectSocialListCreators` / `collectWatchRelatedEntries` + `readWatchInitialData` + `watchRelatedCandidates` |
 * | 链接页（Linktree / Beacons） | 链接页那一条 | `readBioLinkSnapshot` |
 *
 * **只读**：不点、不滚、不发请求、不碰存储；读的是页面上本来就渲染着的东西（与插件同一条自律）。
 * 打包成一段脚本（`page-script.generated.ts`）后由 ego 的 `page.evaluate` 注进页面跑；插件那边是 content script 直接调。
 */

import { withCommerceSignals } from '../collectors/commerceSignals.js'
import { readInstagramPostSnapshot } from '../collectors/instagramPost.js'
import { readInstagramProfileSnapshot } from '../collectors/instagramProfile.js'
import {
  type ListCaptureTarget,
  resolveListCaptureTarget,
} from '../collectors/listCaptureTarget.js'
import { resolvePanelRoute } from '../collectors/panelRoute.js'
import { collectSocialListCreators } from '../collectors/socialList.js'
import { readTikTokProfileSnapshot } from '../collectors/tiktokProfile.js'
import { readTikTokVideoSnapshot } from '../collectors/tiktokVideo.js'
import { readYouTubeChannelSnapshot } from '../collectors/youtubeChannel.js'
import { readVerifiedBusinessEmail } from '../collectors/youtubeEmailReveal.js'
import { readInitialDataScript, readWatchInitialData } from '../collectors/youtubeInitialData.js'
import { readYouTubeWatchSnapshot } from '../collectors/youtubeWatch.js'
import {
  collectWatchRelatedEntries,
  readWatchSeedIdentity,
  watchRelatedCandidates,
} from '../collectors/youtubeWatchRelated.js'
import { type Lang, setActiveLang } from '../kol/language.js'
import { type BioLinkSnapshot, isBioLinkPage, readBioLinkSnapshot } from '../kol/utils/bioLink.js'
import type { ContentSnapshot } from '../kol/utils/contentSnapshot.js'
import type { CapturePlatform, CreatorSnapshot } from '../kol/utils/creatorSnapshot.js'
import {
  collectYouTubeSearchCreators,
  type SearchCreatorCandidate,
} from '../kol/utils/youtubeSearch.js'

/** 与插件内容卡同一张表（插件页面入口的 `CONTENT_SCRAPERS`）。 */
const CONTENT_SCRAPERS: Record<CapturePlatform, () => ContentSnapshot | null> = {
  youtube: () => withCommerceSignals(readYouTubeWatchSnapshot(), 'youtube'),
  tiktok: () => withCommerceSignals(readTikTokVideoSnapshot(), 'tiktok'),
  instagram: () => withCommerceSignals(readInstagramPostSnapshot(), 'instagram'),
}

/** 与插件主页卡同一张表（插件页面入口的 `CREATOR_SCRAPERS`）。 */
const CREATOR_SCRAPERS: Record<CapturePlatform, () => CreatorSnapshot | null> = {
  youtube: readYouTubeChannelSnapshot,
  tiktok: readTikTokProfileSnapshot,
  instagram: readInstagramProfileSnapshot,
}

export interface PageCaptureOptions {
  /** 采集器里那几句兜底说明用哪种语言（插件跟浏览器；不给就跟页面所在浏览器）。 */
  lang?: Lang
}

/** 列表页读到的那一批（插件列表按钮「采集」之前看到的那一份）。 */
export interface PageListCapture {
  target: ListCaptureTarget
  candidates: SearchCreatorCandidate[]
  /** 视频页右栏：身份对不上、被丢掉的条数（插件面板上也数这个）。 */
  unidentified?: number
}

export interface PageCapture {
  href: string
  creator?: CreatorSnapshot
  content?: ContentSnapshot
  bio_link?: BioLinkSnapshot
  list?: PageListCapture
  /** 认得出这一页，但还没读到（页面没渲染完）——调用方等一会儿再读，插件面板也是这样重试的。 */
  pending: boolean
}

function readList(target: ListCaptureTarget): PageListCapture {
  if (target.pageType === 'search') {
    return {
      target,
      candidates:
        target.platform === 'youtube'
          ? collectYouTubeSearchCreators()
          : collectSocialListCreators(target.platform),
    }
  }
  // 视频页右栏：读右栏 → 页内身份对照 → 剔掉种子（与插件列表按钮 `rail` 那一段同一个 join）
  const entries = collectWatchRelatedEntries()
  const seed = readWatchSeedIdentity()
  const identities = readWatchInitialData(readInitialDataScript(), target.videoId ?? null)
  const joined = entries.map((entry) => {
    const found = identities.byVideoId.get(entry.videoId)
    return found
      ? { ...entry, channelExternalId: found.externalId, channelHandle: found.handle }
      : entry
  })
  const out = watchRelatedCandidates(joined, {
    seedExternalId: seed?.externalId,
    seedHandle: seed?.handle,
  })
  return { target, candidates: out.candidates, unidentified: out.unidentified }
}

/** 读一遍这一页。 */
export function capturePage(options: PageCaptureOptions = {}): PageCapture {
  if (options.lang) setActiveLang(options.lang)
  const href = window.location.href
  const out: PageCapture = { href, pending: false }
  let recognised = false
  let read = false

  if (isBioLinkPage(href)) {
    recognised = true
    const snap = readBioLinkSnapshot()
    if (snap) {
      out.bio_link = snap
      read = true
    }
  }

  const route = resolvePanelRoute(href)
  if (route) {
    recognised = true
    if (route.kind === 'content') {
      const snap = CONTENT_SCRAPERS[route.platform]()
      if (snap) {
        out.content = snap
        read = true
      }
    } else {
      let snap = CREATOR_SCRAPERS[route.platform]()
      // 插件主页卡：YouTube「关于」里过完人机验证后弹出来的那个商务邮箱（只认窄读法，决策 1710 = C）
      if (snap && route.platform === 'youtube' && !snap.businessEmail) {
        const verified = readVerifiedBusinessEmail()
        if (verified) snap = { ...snap, businessEmail: verified }
      }
      if (snap) {
        out.creator = snap
        read = true
      }
    }
  }

  const target = resolveListCaptureTarget(href)
  if (target) {
    recognised = true
    const list = readList(target)
    out.list = list
    if (list.candidates.length > 0) read = true
  }

  out.pending = recognised && !read
  return out
}
