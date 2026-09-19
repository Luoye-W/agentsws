/**
 * 58 §1 / §2 设计岗位的五条职责与三个对象（WP76）。
 *
 * **纪律先说（04 §6 / 58 表头，Luoye 原话）**：Agent 出 brief、尺寸规格、变体与
 * 初稿，**视觉决定永远是人**。这一条不是文档里的一句话，它在三个地方写成类型：
 *
 * 1. {@link DesignAsset.status} 里没有"Agent 定稿"这一档——`picked` 那一格必须
 *    带 {@link DesignAssetProvenance.picked_by}（一个 `PersonId`），
 *    而 `published` 走的是 `asset_publish` 这条 ChangeKind，它在
 *    `@agentsws/core` 的 `HARD_L1` 里（yml 放宽不了）。
 * 2. {@link DesignBrief} 里只有**计划**（`variant_plan`），没有"选中的那一张"。
 *    挑哪一张是人在变体卡上点的，不是 brief 里写死的。
 * 3. {@link DesignRequest} 的主语是**别的岗位**（`from_role_id`）——设计岗自己
 *    不发明需求。58 §1 的"需求来源"那一列就是这一格。
 *
 * **五条职责骨架相同，差别只在规格表与需求来源**（58 §1 第一句）。所以这里没有
 * 五份对象定义，只有一张 {@link DESIGN_DUTIES} 与一张 {@link DESIGN_SPECS}。
 *
 * **不在这里的东西**（各有去处，免得有人在这里找）：
 *
 * - 广告素材规格 → WP75 的 `@agentsws/ads-core` 的 `spec.ts`（那个包还没合进
 *   main，所以 WP76 暂时在 `@agentsws/design-core` 的 `specs.ts` 里本地定义一份
 *   形状，合并后改成 import）；
 * - 品牌系统（色 / 字 / 版式 / 禁忌）→ **公司层技能**（24），`design-core`
 *   的 `brand.ts` 只读不编；
 * - 素材字节 → blob store（41 §2）。这个文件从头到尾没有一格放得下一张图。
 * - "定稿永远人审" → `@agentsws/core` 的 `HARD_L1`。
 */

import type { Iso8601, PersonId, WorkspaceId } from './common.js'
import type { ModelRef } from './run.js'

/* ── 五条职责（58 §1）──────────────────────────────────────────────── */

/**
 * 五条职责（58 拆法那一行，Luoye 09-17 手写：**按用途**）。职责 id 是
 * `design.<duty>`。
 *
 * 为什么按用途而不是按产出物（旧 04 §6 那七条作废）：一张主图与一张 A+ 图
 * 是同一个人在同一套 Amazon 规格下同一天做完的，拆成两条职责等于让人为同一件事
 * 连两次、批两次；而"给 Amazon 做"与"给展会做"真正不同的是**规格表**
 * （sRGB 2000px 对 CMYK 出血 3mm）与**需求从谁那儿来**，那正好是一条职责的粒度。
 */
export type DesignDuty = 'dtc' | 'amazon' | 'social' | 'ads' | 'exhibition'

/** 规格族。一条职责可以吃好几族（`design.dtc` 吃 `web`，`design.ads` 吃 `ads`）。 */
export type DesignSpecFamily = 'web' | 'amazon' | 'social' | 'ads' | 'print'

export interface DesignDutySpec {
  id: DesignDuty
  /** 职责 id（`design.amazon`）。**不由调用方现拼**。 */
  role_id: string
  zh: string
  en: string
  /** 出什么（58 §1 的第一段，界面上那一句）。 */
  produces_zh: string
  produces_en: string
  /**
   * 需求单从哪几条职责过来（58 §1 的"来源"那一列）。
   *
   * `human` = 没有上游职责，人手动开（展会设计就是这一条）。写出来是因为
   * 面板的"需求单队列（按来源岗位）"那一块要按它分组——分不出来源的队列
   * 只是一堆卡片。
   */
  request_sources: readonly string[]
  spec_families: readonly DesignSpecFamily[]
}

/**
 * 58 §1 那一段的机器可读版。**只有这一份**：职责 yml、岗位模板、面板分块、
 * 需求单路由都读它，谁都不许再抄一张职责清单（同 `SOCIAL_CHANNELS` 的纪律）。
 *
 * 顺序 = 岗位模板里的摆法（58 §1 的顺序）。
 */
export const DESIGN_DUTIES: readonly DesignDutySpec[] = [
  {
    id: 'dtc',
    role_id: 'design.dtc',
    zh: '独立站设计',
    en: 'DTC Site Design',
    produces_zh: '首页 / 产品页 / 落地页视觉、Banner、图标',
    produces_en: 'Home, product and landing page visuals, banners, icons',
    // 网站运营下需求（`dtc.store` / `dtc.content`）、建站那边要图（`site.*`，WP77 之后才有）
    request_sources: ['dtc.store', 'dtc.content', 'site.shopify-theme'],
    spec_families: ['web'],
  },
  {
    id: 'amazon',
    role_id: 'design.amazon',
    zh: 'Amazon 设计',
    en: 'Amazon Design',
    produces_zh: '主图 / A+ / 品牌旗舰店 / 视频封面（按 Amazon 规格）',
    produces_en: 'Main images, A+ modules, storefront, video covers (Amazon specs)',
    request_sources: ['amz.listing'],
    spec_families: ['amazon'],
  },
  {
    id: 'social',
    role_id: 'design.social',
    zh: '社媒设计',
    en: 'Social Design',
    produces_zh: '帖子 / Reels 封面 / 故事 / 头像与主页视觉（按各平台尺寸）',
    produces_en: 'Posts, Reels covers, stories, avatars and profile visuals',
    request_sources: ['social.meta', 'social.tiktok', 'social.youtube', 'kol.youtube'],
    spec_families: ['social'],
  },
  {
    id: 'ads',
    role_id: 'design.ads',
    zh: '广告设计',
    en: 'Ad Creative Design',
    produces_zh: '各平台广告素材与变体（按投放规格与文案安全区）',
    produces_en: 'Ad creatives and variants per platform spec and text-safe area',
    request_sources: ['ads.meta', 'ads.google', 'ads.tiktok', 'ads.x'],
    spec_families: ['ads'],
  },
  {
    id: 'exhibition',
    role_id: 'design.exhibition',
    zh: '展会设计',
    en: 'Exhibition Design',
    produces_zh: '展位 / 易拉宝 / 画册 / 名片（印刷规格 CMYK / 出血）',
    produces_en: 'Booth, roll-ups, brochures, name cards (CMYK print specs)',
    // 58 §1：展会设计**没有上游职责**，人手动开一件事
    request_sources: ['human'],
    spec_families: ['print'],
  },
]

/** 职责 id（`design.amazon`）→ 规格；不是设计职责回 `undefined`（不编造一条）。 */
export function designDutyOfRole(role_id: string): DesignDutySpec | undefined {
  return DESIGN_DUTIES.find((d) => d.role_id === role_id)
}

/** 用途 id（`amazon`）→ 规格；不认识的回 `undefined`。 */
export function designDutySpec(id: string): DesignDutySpec | undefined {
  return DESIGN_DUTIES.find((d) => d.id === id)
}

/** 五条职责的 id，按出场顺序（`BUNDLED_ROLES` 与岗位模板读它）。 */
export const DESIGN_ROLE_IDS: readonly string[] = DESIGN_DUTIES.map((d) => d.role_id)

/**
 * 一条来源职责该路由到哪条设计职责（54 的岗位路由在设计岗内部跑完之后的兜底）。
 *
 * 写出来是因为"向设计岗下需求单"这个动作在**别的岗位**的 yml 里，那边不认识
 * 五条设计职责；它只说"我是 `social.meta`"，该落到 `design.social` 由这一份表
 * 决定。查不到 → `undefined`，界面上出一张"这件事该归哪条设计职责"的选择卡
 * （54 §2 拿不准就问一句，不猜）。
 */
export function designDutyForSource(role_id: string): DesignDutySpec | undefined {
  return DESIGN_DUTIES.find((d) => d.request_sources.includes(role_id))
}

/* ── 规格表（58 §2 `specs.ts`）────────────────────────────────────── */

/** 色彩模式。印刷是 CMYK，屏幕是 sRGB——两者混用的后果是印出来整体偏色。 */
export type DesignColorMode = 'sRGB' | 'CMYK'

/** 安全区（四边留白）。单位跟 {@link DesignSpec.unit} 走。 */
export interface DesignSafeArea {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * 一条规格。
 *
 * **单位分屏幕与印刷两档**：屏幕用 px（`unit: 'px'`，`dpi` 没有意义），印刷用 mm
 * （`unit: 'mm'` + `dpi` + `bleed_mm`）。合成一档的后果是有人拿 210 当像素做了
 * 一张 A4 画册。
 */
export interface DesignSpec {
  /** `amazon.main` / `social.ig.story` / `print.rollup`。 */
  id: string
  family: DesignSpecFamily
  zh: string
  en: string
  unit: 'px' | 'mm'
  width: number
  height: number
  /** 印刷才有（`unit: 'mm'`）。 */
  dpi?: number
  color_mode: DesignColorMode
  /** 出血（mm）。印刷才有。 */
  bleed_mm?: number
  /** 安全区：平台会盖住或裁掉的那一圈（故事的顶部时间条、YouTube 频道图的两侧）。 */
  safe_area?: DesignSafeArea
  /** 视频类才有：这一格最长多少秒。 */
  max_duration_s?: number
  /** 图上文字的字数上限（Amazon 主图不许有文字 → 0）。 */
  max_text_chars?: number
  /** 平台的硬规矩，原样显示给人看（"主图必须纯白底"）。 */
  note_zh?: string
  note_en?: string
}

/**
 * 58 §2 的规格表。**全仓唯一一份屏幕与印刷规格清单**——brief 里的尺寸、
 * 变体计划里的画布、素材库的分组、界面上的下拉都读它。
 *
 * **广告规格不在这里**：WP75 的 `@agentsws/ads-core` 的 `spec.ts` 才是那一份的
 * 真源（58 表头的"关联"那一行）。那个包还没合进 main，所以 WP76 在
 * `@agentsws/design-core` 的 `specs.ts` 里先本地定义一份形状，合并后改成 import。
 * 在这里再抄一份广告尺寸，等于制造第二个真源。
 *
 * **只加行**（同 15 §2 对规则集的老规矩）：删一条 = 已经按它做过的素材突然没了规格。
 */
export const DESIGN_SPECS: readonly DesignSpec[] = [
  // ── 独立站（`design.dtc`）────────────────────────────────────────
  {
    id: 'web.hero.desktop',
    family: 'web',
    zh: '首页主视觉（桌面）',
    en: 'Home hero (desktop)',
    unit: 'px',
    width: 1920,
    height: 800,
    color_mode: 'sRGB',
    note_zh: '中间 1200px 之外会被宽屏裁掉，主体别放边上',
    note_en: 'Wide screens crop outside the centre 1200px; keep the subject inside',
  },
  {
    id: 'web.hero.mobile',
    family: 'web',
    zh: '首页主视觉（手机）',
    en: 'Home hero (mobile)',
    unit: 'px',
    width: 750,
    height: 1000,
    color_mode: 'sRGB',
  },
  {
    id: 'web.banner',
    family: 'web',
    zh: '活动 Banner',
    en: 'Campaign banner',
    unit: 'px',
    width: 1440,
    height: 480,
    color_mode: 'sRGB',
    max_text_chars: 30,
  },
  {
    id: 'web.product.image',
    family: 'web',
    zh: '产品图',
    en: 'Product image',
    unit: 'px',
    width: 2048,
    height: 2048,
    color_mode: 'sRGB',
    note_zh: 'Shopify 放大镜按 2048 见方取，短边小于它就糊',
    note_en: 'Shopify zoom samples at 2048 square; anything smaller looks soft',
  },
  {
    id: 'web.icon',
    family: 'web',
    zh: '图标',
    en: 'Icon',
    unit: 'px',
    width: 512,
    height: 512,
    color_mode: 'sRGB',
    max_text_chars: 0,
  },
  // ── Amazon（`design.amazon`）─────────────────────────────────────
  {
    id: 'amazon.main',
    family: 'amazon',
    zh: 'Amazon 主图',
    en: 'Amazon main image',
    unit: 'px',
    width: 2000,
    height: 2000,
    color_mode: 'sRGB',
    // 平台硬规矩：主图纯白底、商品占比 85%、**不许有任何文字与水印**
    max_text_chars: 0,
    note_zh: '纯白底（RGB 255,255,255）、商品占画面 85%、不许有文字、水印、边框',
    note_en: 'Pure white background, product fills 85%, no text, watermark or border',
  },
  {
    id: 'amazon.aplus.module',
    family: 'amazon',
    zh: 'A+ 模块图',
    en: 'A+ module image',
    unit: 'px',
    width: 970,
    height: 600,
    color_mode: 'sRGB',
    max_text_chars: 120,
  },
  {
    id: 'amazon.storefront.hero',
    family: 'amazon',
    zh: '品牌旗舰店主视觉',
    en: 'Storefront hero',
    unit: 'px',
    width: 3000,
    height: 600,
    color_mode: 'sRGB',
    safe_area: { top: 0, right: 600, bottom: 0, left: 600 },
    note_zh: '窄屏只看得见中间那一段，两侧各 600px 当作会被裁掉',
    note_en: 'Narrow screens only show the centre; treat 600px on each side as croppable',
  },
  {
    id: 'amazon.video.cover',
    family: 'amazon',
    zh: 'Amazon 视频封面',
    en: 'Amazon video cover',
    unit: 'px',
    width: 1280,
    height: 720,
    color_mode: 'sRGB',
  },
  // ── 社媒（`design.social`）──────────────────────────────────────
  {
    id: 'social.ig.square',
    family: 'social',
    zh: 'Instagram 方图',
    en: 'Instagram square',
    unit: 'px',
    width: 1080,
    height: 1080,
    color_mode: 'sRGB',
  },
  {
    id: 'social.ig.portrait',
    family: 'social',
    zh: 'Instagram 竖图',
    en: 'Instagram portrait',
    unit: 'px',
    width: 1080,
    height: 1350,
    color_mode: 'sRGB',
  },
  {
    id: 'social.ig.story',
    family: 'social',
    zh: 'Instagram 故事 / Reels 封面',
    en: 'Instagram story / Reels cover',
    unit: 'px',
    width: 1080,
    height: 1920,
    color_mode: 'sRGB',
    // 顶部时间条与底部操作条会盖住内容
    safe_area: { top: 250, right: 60, bottom: 320, left: 60 },
    max_duration_s: 60,
  },
  {
    id: 'social.fb.feed',
    family: 'social',
    zh: 'Facebook 信息流图',
    en: 'Facebook feed image',
    unit: 'px',
    width: 1200,
    height: 630,
    color_mode: 'sRGB',
  },
  {
    id: 'social.tiktok.cover',
    family: 'social',
    zh: 'TikTok 封面',
    en: 'TikTok cover',
    unit: 'px',
    width: 1080,
    height: 1920,
    color_mode: 'sRGB',
    safe_area: { top: 180, right: 180, bottom: 500, left: 60 },
    note_zh: '右侧一列按钮与底部文案区会压住内容，别把重点放那儿',
    note_en: 'The right-hand button rail and the bottom caption cover content',
  },
  {
    id: 'social.x.post',
    family: 'social',
    zh: 'X 配图',
    en: 'X post image',
    unit: 'px',
    width: 1600,
    height: 900,
    color_mode: 'sRGB',
  },
  {
    id: 'social.youtube.thumbnail',
    family: 'social',
    zh: 'YouTube 缩略图',
    en: 'YouTube thumbnail',
    unit: 'px',
    width: 1280,
    height: 720,
    color_mode: 'sRGB',
    max_text_chars: 30,
    note_zh: '右下角会被时长角标盖住',
    note_en: 'The duration badge covers the bottom-right corner',
  },
  {
    id: 'social.youtube.banner',
    family: 'social',
    zh: 'YouTube 频道图',
    en: 'YouTube channel banner',
    unit: 'px',
    width: 2560,
    height: 1440,
    color_mode: 'sRGB',
    // 手机上只看得见正中间 1546×423
    safe_area: { top: 508, right: 507, bottom: 509, left: 507 },
    note_zh: '手机只显示正中间 1546×423 那一块，logo 与字都放里面',
    note_en: 'Phones only show the centre 1546x423; keep logo and text inside',
  },
  {
    id: 'social.avatar',
    family: 'social',
    zh: '头像',
    en: 'Avatar',
    unit: 'px',
    width: 1080,
    height: 1080,
    color_mode: 'sRGB',
    note_zh: '所有平台都会裁成圆形，四角当作没有',
    note_en: 'Every platform crops it to a circle; treat the corners as absent',
  },
  // ── 印刷 / 展会（`design.exhibition`）───────────────────────────
  {
    id: 'print.rollup',
    family: 'print',
    zh: '易拉宝',
    en: 'Roll-up banner',
    unit: 'mm',
    width: 800,
    height: 2000,
    dpi: 150,
    color_mode: 'CMYK',
    bleed_mm: 3,
    // 底座会挡住最下面那一截
    safe_area: { top: 50, right: 30, bottom: 300, left: 30 },
    note_zh: '底座挡住最下面约 300mm，重要内容别放那儿',
    note_en: 'The base hides roughly the bottom 300mm',
  },
  {
    id: 'print.booth.backdrop',
    family: 'print',
    zh: '展位背板',
    en: 'Booth backdrop',
    unit: 'mm',
    width: 3000,
    height: 2500,
    dpi: 100,
    color_mode: 'CMYK',
    bleed_mm: 5,
    note_zh: '大幅面按 100dpi 出就够，桁架会压住四边各 50mm',
    note_en: '100dpi is enough at this size; the truss covers 50mm on each edge',
  },
  {
    id: 'print.brochure.a4',
    family: 'print',
    zh: '画册内页（A4）',
    en: 'Brochure page (A4)',
    unit: 'mm',
    width: 210,
    height: 297,
    dpi: 300,
    color_mode: 'CMYK',
    bleed_mm: 3,
    safe_area: { top: 10, right: 10, bottom: 10, left: 10 },
  },
  {
    id: 'print.namecard',
    family: 'print',
    zh: '名片',
    en: 'Name card',
    unit: 'mm',
    width: 90,
    height: 54,
    dpi: 300,
    color_mode: 'CMYK',
    bleed_mm: 3,
    safe_area: { top: 5, right: 5, bottom: 5, left: 5 },
  },
]

/** 规格 id → 规格；不认识的回 `undefined`（**不编一条出来**）。 */
export function designSpec(id: string): DesignSpec | undefined {
  return DESIGN_SPECS.find((s) => s.id === id)
}

/** 这一族的规格（界面上的下拉按它分组）。 */
export function designSpecsOfFamily(family: DesignSpecFamily): readonly DesignSpec[] {
  return DESIGN_SPECS.filter((s) => s.family === family)
}

/**
 * 58 §6 的三个默认额度。写在契约里而不是只写在 yml 里，是因为面板上那句
 * "今天还能出几张"要与 guardrail 判的是同一个数。
 */
export const DESIGN_CAPS = {
  /** 每 brief 最多几张变体（58 §6）。 */
  max_variants_per_brief: 6,
  /** 每天最多调几次图片模型（58 §6）。 */
  max_generations_per_day: 30,
  /** 每天最多出几份 brief（58 §6）。 */
  max_brief_per_day: 10,
} as const

/* ── 三个对象（58 §5 WP76 那一行）────────────────────────────────── */

/**
 * 一张需求单走到哪一步了。
 *
 * `awaiting_pick` 单列是这套东西的全部意义：**人没点"就这张"之前什么都不算定稿**
 * （58 §1 上限那一列）。把它混进 `generating` 里，面板上就再也分不出
 * "机器还在跑"与"在等你看一眼"——后者是唯一需要人的那一格。
 */
export type DesignRequestStatus =
  | 'queued'
  | 'briefed'
  | 'generating'
  | 'awaiting_pick'
  | 'delivered'
  | 'cancelled'

/**
 * **别的岗位下过来的一张需求单**（58 §1 / 54：事项从别的岗位路由过来）。
 *
 * 主语是需求方不是设计岗：`from_role_id` 必填，因为面板的"需求单队列（按来源岗位）"
 * 按它分组，而且交付的时候要**回给需求方**（58 §1 写那一列的最后一句）。
 */
export interface DesignRequest {
  id: string
  workspace_id: WorkspaceId
  /** 路由到哪条设计职责。拿不准时由人在选择卡上定（54 §2），不猜。 */
  duty: DesignDuty
  /** 哪条职责下的单（`social.meta` / `dtc.store`）；人手动开的填 `human`。 */
  from_role_id: string
  /** 哪个岗位（54 §5.2：岗位模板 id，与 Assignment id 分两格）。 */
  from_position_template_id?: string
  /** 这张需求单挂在哪件事项上（37 §2.2b：事项 = 上下文的家）。 */
  matter_id?: string
  title: string
  /**
   * 需求原文。**外部文本**——它是别的岗位（甚至顾客的一句话）写的，
   * 进模型上下文前要围栏（21 §1 / 39），不当指令读。
   */
  need: string
  /** 要哪几个规格（{@link DESIGN_SPECS} 的 id）。空 = 还没定，brief 那一步定。 */
  spec_ids: readonly string[]
  /** 什么时候要。过期的需求单在面板上单独一行——不是"逾期"，是"这件事没做成"。 */
  due_at?: Iso8601
  /** 给哪些商品做（只读引用，设计岗一辈子改不动一件商品）。 */
  product_refs?: readonly string[]
  /** 参考图（素材库里的 {@link DesignAsset} id）。 */
  reference_asset_ids?: readonly string[]
  status: DesignRequestStatus
  created_at: Iso8601
  updated_at?: Iso8601
}

/** brief 里的一条变体计划：一个画布 + 一个角度 + 一段提示词。 */
export interface DesignVariantPlanItem {
  id: string
  /** 画在哪个规格上（{@link DESIGN_SPECS} 的 id）。 */
  spec_id: string
  /** 这一版想试什么（"实拍摆台""只有产品与一句话""用户手持"）。 */
  angle_zh: string
  angle_en?: string
  /**
   * 组装好的提示词。品牌系统（色 / 字 / 版式）已经注入进来了
   * （`design-core` 的 `variants.ts`）；**禁忌词由 guardrail 再查一遍**——
   * 组装那一步查过不算数，组装那一步是 Agent 写的。
   */
  prompt: string
}

/**
 * 需求单 → brief（58 §2 `brief.ts` 的产物）。
 *
 * 里面**没有**"选中的那一张"：brief 只出目标、受众、尺寸、文案、禁忌与变体计划。
 * 挑哪一张是人在变体卡上点的（文件头第 2 条）。
 */
export interface DesignBrief {
  id: string
  workspace_id: WorkspaceId
  request_id: string
  duty: DesignDuty
  /** 这张图要达成什么（"让人看懂它能塞进背包"）。 */
  goal: string
  /** 给谁看。 */
  audience: string
  /** 一句话主张。 */
  key_message: string
  /** 图上要出现的文案（按 {@link DesignSpec.max_text_chars} 截断前的原文）。 */
  copy: readonly string[]
  /** 出哪几个规格。 */
  spec_ids: readonly string[]
  /**
   * 不许出现的东西（品牌禁忌 + 平台硬规矩）。
   *
   * 两个来源合成一张表：品牌系统里写的那几条（公司层技能）与规格上的
   * `note_zh` / `max_text_chars`。guardrail 拿它去查提示词——所以它必须是
   * 一串**词**，不是一段话。
   */
  must_avoid: readonly string[]
  /** 用的是哪一份品牌系统（公司层技能的名字）。缺 → 出"先设品牌系统"卡。 */
  brand_system?: string
  variant_plan: readonly DesignVariantPlanItem[]
  created_at: Iso8601
}

/**
 * 一张素材在素材库里的状态。
 *
 * **没有"Agent 定稿"这一档**（文件头第 1 条）：`variant` 是机器出的初稿，
 * `picked` 是人点过"就这张"，`published` 是入库并回给需求方（走 `asset_publish`，
 * 硬顶 L1）。`rejected` 是人点了"都不行再来"——留着是因为下一轮提示词要知道
 * 上一轮被否了什么。
 */
export type DesignAssetStatus = 'variant' | 'picked' | 'published' | 'rejected'

/**
 * 一张素材的来源（58 §1 末行：每张素材带来源）。
 *
 * 四样缺一不可的理由各不相同：`brief_id` 说它为哪件事做的；`model` 说它是哪个
 * 模型出的（换模型之后回头查"那一批怎么都偏黄"）；`prompt_sha256` 说提示词是
 * 哪一版（**存哈希不存原文**：提示词里可能带客户名与未发布的卖点）；
 * `picked_at` / `picked_by` 说**人**在什么时候点的头——没有这两格的素材，
 * 按定义就不是定稿。
 */
export interface DesignAssetProvenance {
  source: 'generated' | 'uploaded' | 'external'
  brief_id?: string
  variant_plan_item_id?: string
  model?: ModelRef
  prompt_sha256?: string
  generated_at?: Iso8601
  /** 人点"就这张"的那一下。**Agent 填不了这两格**（服务端按请求人盖）。 */
  picked_by?: PersonId
  picked_at?: Iso8601
}

/**
 * 素材库里的一张素材。
 *
 * **字节不在这里**：`blob_uri` 指向 blob store（41 §2），按品牌分前缀。
 * 这个接口里没有一格放得下一张图——同 `SocialPost.media_refs` 的纪律。
 */
export interface DesignAsset {
  id: string
  workspace_id: WorkspaceId
  duty: DesignDuty
  brief_id?: string
  request_id?: string
  /** 按哪个规格出的（{@link DESIGN_SPECS} 的 id）。 */
  spec_id: string
  status: DesignAssetStatus
  /** `blob://…`。没有 = 这一条还只是一个计划，不是一张图。 */
  blob_uri?: string
  content_type?: string
  width?: number
  height?: number
  bytes?: number
  /** 按用途打的标（素材库按它分组：`hero` / `banner` / `story`）。 */
  tags?: readonly string[]
  /**
   * 规范自检那一行（71 §5，WP122）：出这张图的那条提示词里，有哪些地方不合
   * 这个品牌的 `DESIGN.md`（色板外的颜色、字体表外的字体……）。
   *
   * **只是一句话，不是一道闸**：挑图卡与定稿卡上原样显示它，没有任何一条通路
   * 拿它去拦人。要存下来的理由：定稿是另一次请求，那一跳手上只有这张素材，
   * 而提示词原文我们只留了哈希（58 §1 末行）——不存这一行，当初提过什么就再也
   * 说不清了。
   */
  design_note?: string
  provenance: DesignAssetProvenance
  created_at: Iso8601
  updated_at?: Iso8601
}

/**
 * 一张素材算不算定稿。**唯一一份判据**——界面、路由与 guardrail 读同一个函数。
 *
 * 写成函数而不是让每处自己判 `status === 'published'`：定稿的定义是两件事
 * （状态到了 + **人**点过），少判一件就等于让 Agent 自己定了稿。
 */
export function isDesignAssetFinal(asset: DesignAsset): boolean {
  return (
    asset.status === 'published' &&
    asset.provenance.picked_by !== undefined &&
    asset.provenance.picked_at !== undefined
  )
}
