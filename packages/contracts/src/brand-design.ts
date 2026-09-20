/**
 * 每个品牌一份 `DESIGN.md`（71，WP122）。
 *
 * **格式不是我们发明的。** 前面那段 YAML 与后面那些 `##` 小节，逐字对齐
 * Google Labs 开源的 DESIGN.md 规范（`github.com/google-labs-code/design.md`，
 * Apache-2.0，版本 `alpha`）。用通用格式的好处只有一条，但它够大：用户把这份
 * 文件拿去 Stitch / Claude Code / Cursor 也能直接用——**我们不自造格式**。
 *
 * 那份规范里的 YAML 是**裸值**（`primary: "#1A1C1E"`）。我们多一层：
 *
 * | 我们多的 | 它回答 |
 * |---|---|
 * | {@link BrandDesignSource} | 这个色是**从哪个页面的哪一条 CSS 变量**（或手册第几页）来的 |
 * | `confidence` | 有多大把握（沿用 WP121 的三档，界面上只分三种画法） |
 * | `edited` | 用户手改过没有（**重新抓不覆盖改过的格子**，与 70 §3.4 同一条规矩） |
 * | `conflict` | 手册说是 A、官网抓到的是 B。**两个都留着**，在界面上并排让用户选 |
 *
 * 最后一格是这份契约里最不显然的一格。品牌手册里写的规范与官网上实际长的样子
 * **经常不一样**（官网可能没照手册做，也可能手册过期了）。哪个对，我们没资格
 * 替用户判——所以不合并、不取平均、不按把握度压一个下去，两个都端到他面前。
 *
 * **导出的那份 `DESIGN.md` 里没有这一层**：{@link BrandDesignProfile} 是我们
 * 的库内形状，落到文件上的是 {@link DesignTokens}（纯规范）。出处与把握度进
 * 界面，不进那份要给别的工具吃的文件。
 */

import type { BrandIntakeConfidence } from './brand-intake.js'
import type { Iso8601, PersonId, WorkspaceId } from './common.js'

/* ── 一、规范本体（逐字对齐 design.md alpha）────────────────────────── */

/** 我们跟的规范版本。规范自己说它是 `alpha`，所以这里也是 `alpha`。 */
export const DESIGN_MD_SPEC_VERSION = 'alpha'

/**
 * 正文的八个小节，**顺序是规范定的**（在场的必须按这个次序出现）。
 *
 * 规范允许整节省略，但省略的要记进 {@link DesignTokens.omitted}——
 * 否则它自己的 linter 会报"缺一节"。我们抓不到的那几节就走这条路：
 * 写「未找到，请补充」的同时，把节名记进 `omitted` 并附一句原因。
 */
export const DESIGN_MD_SECTIONS = [
  'Overview',
  'Colors',
  'Typography',
  'Layout',
  'Elevation & Depth',
  'Shapes',
  'Components',
  "Do's and Don'ts",
] as const

export type DesignMdSection = (typeof DESIGN_MD_SECTIONS)[number]

/**
 * 一级排版令牌（规范的 `Typography`）。
 *
 * `lineHeight` 允许无单位数字（`1.6` = 字号的倍数，CSS 里推荐的写法），
 * 所以它是 `string | number` 而不是 `string`。
 */
export interface DesignTypography {
  fontFamily?: string
  /** Dimension：带单位的串（`48px` / `3rem` / `1em`）。 */
  fontSize?: string
  fontWeight?: number
  /** Dimension 或无单位倍数。 */
  lineHeight?: string | number
  letterSpacing?: string
  fontFeature?: string
  fontVariation?: string
}

/** 规范认的组件属性名。其余的属性规范说"收下但告警"，我们照收。 */
export const DESIGN_COMPONENT_PROPS = [
  'backgroundColor',
  'textColor',
  'typography',
  'rounded',
  'padding',
  'size',
  'height',
  'width',
] as const

/** 整节省略的登记（规范的 `omitted`）。 */
export interface DesignOmittedSection {
  section: string
  /** 为什么没有。我们这边永远填——「官网上没找到」也是一句话。 */
  reason?: string
}

/**
 * 落到 `DESIGN.md` 文件头上的那段 YAML。**纯规范，没有我们的私货**。
 *
 * 一个例外，标在这里免得有人当成规范的一部分：`shadows`。规范把阴影放在正文的
 * 「Elevation & Depth」里当散文写，没有对应的令牌组；但我们的主题沙箱（WP89）
 * 与自检都要拿一个能比对的值，所以多一个 `shadows` 组。规范对"不认识的内容"
 * 的规定是**保留、不报错**，所以这样写出去的文件在它的工具里仍然读得动。
 */
export interface DesignTokens {
  version?: string
  name?: string
  description?: string
  omitted?: (string | DesignOmittedSection)[]
  /** CSS 颜色串（`#rrggbb` 优先；`oklch()` 之类照样合法）。 */
  colors?: Record<string, string>
  typography?: Record<string, DesignTypography>
  /** 圆角。Dimension。 */
  rounded?: Record<string, string>
  /** 间距阶梯。Dimension 或无单位数（栅格列数这类）。 */
  spacing?: Record<string, string | number>
  /** 组件样式。值可以是字面量，也可以是 `{colors.primary}` 这种引用。 */
  components?: Record<string, Record<string, string>>
  /** **我们的扩展**（见上）。值是完整的 `box-shadow` 串。 */
  shadows?: Record<string, string>
}

/* ── 二、我们多的那一层：出处、把握度、冲突 ────────────────────────── */

/** 这个值是从哪条路来的。 */
export type BrandDesignOrigin =
  /** 从官网抓的（与 WP121 同一次抓取） */
  | 'site'
  /** 从用户上传的品牌手册 / 图片 / Office 文件里读的 */
  | 'file'
  /** 用户自己填的 / 改的 */
  | 'manual'
  /** Shopify 主题设置里读的（有连接时） */
  | 'theme'

/**
 * 出处。**一个值可以有好几条**（同一个色在首页与商品页都出现过）。
 *
 * `weight` 是判主次用的那个数：**按面积与出现位置算，不只按频次**。一个只在
 * 页脚出现 40 次的灰，主次上排不过一个铺满首屏的品牌色——只数次数的话会把
 * 边框灰判成主色，这是所有"数一数最多的颜色"式实现共同的坑。
 */
export interface BrandDesignSource {
  origin: BrandDesignOrigin
  /** `site` / `theme` 这两条路上：哪一页。 */
  url?: string
  /**
   * 从哪儿拿的：
   * `css-var:--color-primary` / `css:.btn{background-color}` /
   * `inline:header` / `theme:colors.accent` / `pdf:p3` / `model:vision`。
   */
  locator?: string
  /** `file` 这条路上：第几页（从 1 数）。 */
  page?: number
  /** 页面 / 手册上那一小段原文（截断）。给人核对用的锚点。 */
  quote?: string
  /**
   * 权重（面积 × 位置的估算，见上）。只在同一组令牌内部可比，跨组没意义。
   */
  weight?: number
}

/**
 * 与另一条来路冲突的那个值。
 *
 * **不合并**：手册说主色是 `#b8422e`、官网上量出来是 `#c04a33`，这两个数没有
 * 中间答案。规则是**手册优先**（文件里写的是规范，官网是实现，实现可能没跟上），
 * 但优先不等于把另一个删掉——界面上并排标出来让用户点一下。
 */
export interface BrandDesignConflict<T> {
  value: T
  source: BrandDesignSource[]
}

/**
 * 一格：值 + 出处 + 把握度 + 改没改过 + 有没有另一种说法。
 *
 * 与 WP121 的 `BrandIntakeField` 是**两个类型**，故意的：那边一格对应界面上一行
 * 文本，这边一格对应一个色块 / 一段字样，多了 `conflict` 这一格，`evidence`
 * 也换成了能记 PDF 页码的 {@link BrandDesignSource}。共用的只有把握度那三档。
 */
export interface BrandDesignValue<T> {
  value: T
  confidence: BrandIntakeConfidence
  /** 至少一条。一条出处都没有的值不该出现。 */
  source: BrandDesignSource[]
  /** 用户手改过。重抓时整格跳过。 */
  edited?: boolean
  /** 另一条来路给的不同答案（见 {@link BrandDesignConflict}）。 */
  conflict?: BrandDesignConflict<T>
}

/** logo 的一份（深底 / 浅底 / 纯标记各算一份）。 */
export interface BrandDesignLogo {
  /** 本机 blob 引用或原站地址。**别人站上的图片我们不转存**，只存 logo 本身。 */
  url: string
  /** 这一份是给什么底用的。 */
  variant: 'light' | 'dark' | 'mono' | 'mark'
  /** 最小显示宽度（px）。手册里写了才有。 */
  min_width_px?: number
  /** 四周留白，按 logo 高度的倍数（手册里最常见的写法）。 */
  clear_space_ratio?: number
}

/**
 * 库内的品牌设计档案。**每一格都是 {@link BrandDesignValue}，没有裸值。**
 *
 * 与 {@link DesignTokens} 一一对应，外加四格规范里没有、但四个岗位天天要用的：
 * logo、图片风格、动效倾向、语气。前三格进 `DESIGN.md` 的正文散文，
 * 第四格进 WP120 的 persona。
 */
export interface BrandDesignProfile {
  name?: BrandDesignValue<string>
  description?: BrandDesignValue<string>
  colors?: Record<string, BrandDesignValue<string>>
  typography?: Record<string, BrandDesignValue<DesignTypography>>
  rounded?: Record<string, BrandDesignValue<string>>
  spacing?: Record<string, BrandDesignValue<string | number>>
  shadows?: Record<string, BrandDesignValue<string>>
  components?: Record<string, Record<string, BrandDesignValue<string>>>
  /** 深浅版各一份。 */
  logos?: BrandDesignValue<BrandDesignLogo[]>
  /** 图片风格：摄影 / 插画、色调、构图。视觉模型看着截图写的一段话。 */
  imagery?: BrandDesignValue<string>
  /** 动效倾向：有没有过渡、快慢、缓动。 */
  motion?: BrandDesignValue<string>
  /** 视觉气质与语气的那一两句（进 persona 的品牌上下文）。 */
  voice?: BrandDesignValue<string>
}

/* ── 三、文档本体与版本历史 ──────────────────────────────────────── */

/**
 * 一份 `DESIGN.md`。**一个品牌（工作区）一份**，存本机。
 *
 * `markdown` 是**真源**：可整份粘贴替换，粘进来什么就是什么。`profile` 与
 * `tokens` 是从它解析出来的投影——但反过来也成立（在界面上改一个色块，
 * 重新序列化出 `markdown`）。两边不一致时以哪边为准，看用户最后动的是哪一边，
 * 所以这两格永远一起写，不单独更新。
 */
export interface BrandDesignDoc {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  /** 从 1 开始，每存一次 +1。 */
  revision: number
  /** 文件原文（YAML front matter + Markdown 正文）。 */
  markdown: string
  /** 从 `markdown` 的 front matter 解析出来的裸令牌。 */
  tokens: DesignTokens
  /** 带出处与把握度的那一份（界面用；文件里没有这一层）。 */
  profile: BrandDesignProfile
  created_at: Iso8601
  updated_at: Iso8601
  /** 最近一次是谁写的。机器写的留空。 */
  updated_by?: PersonId
}

/** 一次改动（版本历史；可回看、可导出）。 */
export interface BrandDesignRevision {
  doc_id: string
  revision: number
  markdown: string
  at: Iso8601
  /** 这一版怎么来的。 */
  reason: 'site_extract' | 'file_extract' | 'manual_edit' | 'paste_replace' | 'compose'
  by?: PersonId
  /** 一句人话（「从官网抓到 6 色 2 字体」）。 */
  note?: string
}

/* ── 四、抽取与成文 ───────────────────────────────────────────────── */

/** 抽取的一轮跑到哪一步了。 */
export type BrandDesignRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirm'
  | 'confirmed'
  | 'budget_exceeded'
  | 'failed'

/** 上传进来的一个文件抽出来什么（品牌手册那条路）。 */
export interface BrandDesignFileIntake {
  /** 知识库里那份上传的 id（复用 WP99 的上传链路，字节不另存一份）。 */
  upload_id: string
  filename: string
  /** 总页数（PDF / pptx）。 */
  pages?: number
  /** 这个文件贡献了哪几格（字段路径，`colors.primary` 这种）。 */
  contributed: string[]
  /** 读不动的时候那一句人话。**不编。** */
  failure?: string
}

/**
 * 手册里的一个色。
 *
 * **Pantone / CMYK 原样保留**并另存换算出来的 HEX：印刷厂要的是前者，
 * 屏幕上画色块要的是后者。把 Pantone 换算成 HEX 之后就把原值扔掉，等于
 * 让这份文件再也回不到印刷那一侧。
 */
export interface BrandDesignPrintColor {
  /** 手册上写的原样（`PANTONE 186 C`、`C0 M100 Y81 K4`）。 */
  raw: string
  space: 'pantone' | 'cmyk' | 'rgb' | 'hex'
  /** 换算出来的 `#rrggbb`（换算不了就没有这一格）。 */
  hex?: string
}

/** 一次抽取。 */
export interface BrandDesignRun {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  status: BrandDesignRunStatus
  /** 这一轮走的哪几条路。 */
  origins: BrandDesignOrigin[]
  /** 官网那条路上抓过的页面（与 WP121 同一次抓取时，这里是那一次的子集）。 */
  pages: { url: string; ok: boolean; reason?: string }[]
  files: BrandDesignFileIntake[]
  profile: BrandDesignProfile
  /** 成文那一步花了多少。 */
  budget: { estimated_credits: number; cap_credits: number; spent_credits: number }
  created_at: Iso8601
  updated_at: Iso8601
  failure?: string
}

/**
 * 成文（写正文散文）那一步的积分封顶。
 *
 * 1 是对着 WP121 的 2 定的：贴一个网址那一轮已经花掉最多 2，设计规范这一轮
 * 再花 1，加起来 3，**仍然在注册送的 10 以内**，剩 7 够几十轮便宜档对话。
 * 抽取本身（读 CSS、解析 PDF 文字）不要钱，要钱的只有喂给模型的那些 token
 * 与看截图的那几次视觉调用。
 */
export const DEFAULT_BRAND_DESIGN_CAP_CREDITS = 1

/** 看一张截图 / 一页手册按多少积分算（视觉档比文字档贵）。 */
export const CREDITS_PER_VISION_CALL = 0.1

/** 品牌手册最多读几页（再多也不会让第一版更准，只会更贵）。 */
export const BRAND_DESIGN_MAX_FILE_PAGES = 24

/* ── 五、规范自检（产出物合不合这份规范）────────────────────────── */

/** 自检看哪几件事。 */
export type BrandDesignCheckKind =
  /** 用了色板以外的颜色 */
  | 'color_off_palette'
  /** 用了字体表以外的字体 */
  | 'font_off_list'
  /** logo 比手册写的最小尺寸还小 */
  | 'logo_min_size'
  /** logo 四周留白不够 */
  | 'logo_clear_space'
  /** 前景背景对比度不达标（WCAG AA） */
  | 'contrast'

/**
 * 自检出来的一条。
 *
 * **没有 `error` 这一档，只有提示。** 这道检查是贴在卡片上的一行字，
 * 不是一道闸：品牌规范是给人省事的，不是用来拦住人出活的。一张广告图用了
 * 色板外的一个橙，很可能是设计师故意的。
 */
export interface BrandDesignCheckFinding {
  kind: BrandDesignCheckKind
  /** 界面上那一句人话（「这张图里的 #ff7a00 不在品牌色板里」）。 */
  message_zh: string
  message_en: string
  /** 涉及的值（颜色串 / 字体名）。 */
  found?: string
  /** 规范里最接近的那个（界面上给「改成这个？」）。 */
  suggestion?: string
}

/** WCAG AA 正文对比度。小字 4.5:1，大字 3:1。 */
export const WCAG_AA_CONTRAST = 4.5
export const WCAG_AA_LARGE_CONTRAST = 3

/* ── 六、给四个岗位用的那一份上下文 ──────────────────────────────── */

/**
 * 注入到出图 / 出页面 / 出邮件模板 / 出广告素材的提示里的那一份。
 *
 * **只有一个来源**（`brandDesignContext()`，在 `@agentsws/brand-design` 里）。
 * 四个 core 各拼一遍的话，过两周它们就会拼得不一样——而"为什么社媒出的图
 * 和建站出的页面不是一套颜色"这种问题，没人查得出来。
 */
export interface BrandDesignContext {
  /** 有没有这份规范。没有的时候四个 core 照常干活，只是不注入。 */
  present: boolean
  /** 直接塞进提示词的那一段（已经是人话，不要再加工）。 */
  prompt: string
  /** 给主题沙箱（WP89）与自检用的裸令牌。 */
  tokens: DesignTokens
  /** 色板里允许的颜色（自检拿它比对）。 */
  palette: string[]
  /** 字体表。 */
  fonts: string[]
}
