/**
 * 四个平台的素材规格表（57 §2：尺寸 / 时长 / 文案字数 / 安全区）。
 *
 * **设计岗的 `design.ads` 读的就是这一份**（57 §1 末段 / 58）：出广告图之前它要
 * 知道"这个位要多大、竖的还是方的、文案能写多少字、底下那条安全区别压字"。
 * 所以这张表放在投放这一侧而不是设计那一侧——尺寸是**平台的事实**，不是设计偏好，
 * 而认得这件事实的是接平台接口的那一方。设计那边 `import` 它，不抄第二份。
 *
 * 三条纪律：
 *
 * 1. **一条规格 = 一个真实广告位**，不是"1:1 / 9:16"这种比例清单。比例不够用：
 *    同样是 9:16，Reels 底部有 250px 会被界面压住，TikTok 是 480px——出图的人
 *    要的是后者那个数。
 * 2. **拿不到的一律 `undefined`，不写一个"通用值"**。Google 响应式搜索广告没有
 *    尺寸这回事（它拼的是文字），`width` / `height` 就空着；不空的话设计那边会
 *    按一个编出来的数出图。
 * 3. **只可加行**。平台改了规格是加一条新的、把旧的标 `deprecated_note`，
 *    不是就地改数——已经按旧规格出过的那批图还在跑着，改数等于让历史对不上。
 */

import type { AdsPlatform } from '@agentsws/contracts'

/**
 * 安全区：四边各留多少像素别放字（平台界面会压住那一块）。
 *
 * 不给就是这个位没有安全区这回事（静态图广告多数如此）。
 */
export interface AdSafeArea {
  top?: number
  bottom?: number
  left?: number
  right?: number
  /** 一句人话：这块是被什么压住的。卡面与 brief 上原样引用。 */
  note?: string
}

/**
 * 一个广告位的素材规格。
 *
 * 形状由 57 §2 定死（WP76 的 `design.ads` 按这个形状 `import`）：
 * `{ platform, placement, width, height, max_duration_s?, max_text_chars?, safe_area? }`。
 */
export interface AdCreativeSpec {
  platform: AdsPlatform
  /** 广告位 id（平台自己的叫法，小写下划线）。 */
  placement: string
  /** 中文名（brief 与面板上那一个）。 */
  zh: string
  /** 像素宽。文字类广告位没有这一格（文件头第 2 条）。 */
  width?: number
  height?: number
  /** 视频最长多少秒。静态位没有这一格。 */
  max_duration_s?: number
  /** 主文案最多多少字符。 */
  max_text_chars?: number
  /** 标题最多多少字符（有独立标题栏的位才有）。 */
  max_headline_chars?: number
  safe_area?: AdSafeArea
  /** 这条是什么形态（brief 上要先说清出图还是出片）。 */
  asset: 'image' | 'video' | 'text'
}

/**
 * 57 §2 那张表。**全仓只有这一份**：投放的素材变体、设计岗的 brief、
 * 面板上"这条广告的素材合不合规"读的都是它。
 *
 * 事实来源：各平台公开的广告规格文档（2026-09-17 读）。改了就加一行，别改旧行。
 */
export const AD_CREATIVE_SPECS: readonly AdCreativeSpec[] = [
  /* ── Meta ───────────────────────────────────────────────────────── */
  {
    platform: 'meta',
    placement: 'feed_square',
    zh: 'Facebook / Instagram 信息流（方图）',
    width: 1080,
    height: 1080,
    max_text_chars: 125,
    max_headline_chars: 40,
    asset: 'image',
  },
  {
    platform: 'meta',
    placement: 'stories_reels',
    zh: 'Stories / Reels（竖屏）',
    width: 1080,
    height: 1920,
    max_duration_s: 60,
    max_text_chars: 125,
    safe_area: {
      top: 250,
      bottom: 340,
      note: '上面是账号名与关闭按钮，下面是"了解更多"那一条。字压上去在手机上直接看不见。',
    },
    asset: 'video',
  },
  {
    platform: 'meta',
    placement: 'feed_video',
    zh: '信息流视频（4:5）',
    width: 1080,
    height: 1350,
    max_duration_s: 241,
    max_text_chars: 125,
    asset: 'video',
  },
  /* ── Google ─────────────────────────────────────────────────────── */
  {
    platform: 'google',
    placement: 'responsive_search',
    zh: '响应式搜索广告（纯文字）',
    // 没有尺寸这回事：它拼的是文字（文件头第 2 条）
    max_headline_chars: 30,
    max_text_chars: 90,
    asset: 'text',
  },
  {
    platform: 'google',
    placement: 'display_landscape',
    zh: '展示广告（横图 1.91:1）',
    width: 1200,
    height: 628,
    max_headline_chars: 30,
    max_text_chars: 90,
    asset: 'image',
  },
  {
    platform: 'google',
    placement: 'display_square',
    zh: '展示广告（方图）',
    width: 1200,
    height: 1200,
    max_headline_chars: 30,
    max_text_chars: 90,
    asset: 'image',
  },
  {
    platform: 'google',
    placement: 'youtube_instream',
    zh: 'YouTube 视频内广告',
    width: 1920,
    height: 1080,
    max_duration_s: 180,
    asset: 'video',
  },
  /* ── X ──────────────────────────────────────────────────────────── */
  {
    platform: 'x',
    placement: 'promoted_image',
    zh: '推广推文（横图 16:9）',
    width: 1200,
    height: 675,
    // 推文正文的老上限；广告文案照它算
    max_text_chars: 280,
    asset: 'image',
  },
  {
    platform: 'x',
    placement: 'promoted_video',
    zh: '推广视频',
    width: 1200,
    height: 1200,
    max_duration_s: 140,
    max_text_chars: 280,
    asset: 'video',
  },
  /* ── TikTok ─────────────────────────────────────────────────────── */
  {
    platform: 'tiktok',
    placement: 'in_feed',
    zh: '信息流视频（竖屏）',
    width: 1080,
    height: 1920,
    max_duration_s: 60,
    max_text_chars: 100,
    safe_area: {
      top: 130,
      bottom: 480,
      right: 140,
      note: '右边那一竖排是点赞 / 评论 / 分享，下面是账号名与文案。这三块是全平台最狠的一档安全区。',
    },
    asset: 'video',
  },
  {
    platform: 'tiktok',
    placement: 'spark_ads',
    zh: 'Spark Ads（引用一条有机视频）',
    width: 1080,
    height: 1920,
    max_duration_s: 60,
    max_text_chars: 100,
    safe_area: {
      bottom: 480,
      note: '引用的是号上已经发过的那条视频，所以素材本身不重出——这条规格是给"挑哪条来投"用的。',
    },
    asset: 'video',
  },
]

/** 这个平台的全部规格（按表里的顺序）。 */
export function specsOfPlatform(platform: string): readonly AdCreativeSpec[] {
  return AD_CREATIVE_SPECS.filter((s) => s.platform === platform)
}

/** 一条具体规格；不认识的回 `undefined`（**不编造一条**）。 */
export function creativeSpec(platform: string, placement: string): AdCreativeSpec | undefined {
  return AD_CREATIVE_SPECS.find((s) => s.platform === platform && s.placement === placement)
}

/** 一条素材对不对得上规格的结论（`ok` 为假时 `problems` 里是给人看的话）。 */
export interface SpecCheck {
  ok: boolean
  problems: string[]
}

/**
 * 一条素材 / 一段文案对不对得上这个位的规格。
 *
 * 只判**给得出来的那几格**：没给宽高就不判尺寸（拿不到不等于不合规）。
 * 判不了的事不报错，这是 36 §3 那条"说不出所以然的空图比没有更糟"的另一面。
 */
export function checkAgainstSpec(
  spec: AdCreativeSpec,
  asset: { width?: number; height?: number; duration_s?: number; text?: string; headline?: string },
): SpecCheck {
  const problems: string[] = []
  if (
    spec.width !== undefined &&
    spec.height !== undefined &&
    asset.width !== undefined &&
    asset.height !== undefined &&
    (asset.width !== spec.width || asset.height !== spec.height)
  )
    problems.push(
      `尺寸对不上：${spec.zh} 要 ${spec.width}×${spec.height}，这张是 ${asset.width}×${asset.height}。`,
    )
  if (
    spec.max_duration_s !== undefined &&
    asset.duration_s !== undefined &&
    asset.duration_s > spec.max_duration_s
  )
    problems.push(
      `时长超了：${spec.zh} 最多 ${spec.max_duration_s} 秒，这条 ${asset.duration_s} 秒。`,
    )
  if (
    spec.max_text_chars !== undefined &&
    asset.text !== undefined &&
    [...asset.text].length > spec.max_text_chars
  )
    problems.push(
      `文案超了：${spec.zh} 最多 ${spec.max_text_chars} 字，这段 ${[...asset.text].length} 字——超出的部分平台会截掉。`,
    )
  if (
    spec.max_headline_chars !== undefined &&
    asset.headline !== undefined &&
    [...asset.headline].length > spec.max_headline_chars
  )
    problems.push(
      `标题超了：${spec.zh} 最多 ${spec.max_headline_chars} 字，这条 ${[...asset.headline].length} 字。`,
    )
  return { ok: problems.length === 0, problems }
}
