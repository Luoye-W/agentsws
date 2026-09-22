/**
 * 品牌设计规范 `DESIGN.md`（71，WP122）。
 *
 * **这个包不联网、不碰库、不认识模型**（与 `@agentsws/brand-intake` 同一条纪律）。
 * 它有六样东西：
 *
 * | 模块 | 干什么 |
 * |---|---|
 * | `color` / `css` / `weight` | 认颜色、拆 CSS、判主次 |
 * | `site-design` | 从已经抓回来的 HTML + CSS 里抽令牌 |
 * | `site-fetch` | 唯一一处额外请求：外链样式表（口子是注入的 `PageFetch`） |
 * | `file-design` | 从品牌手册（PDF / 文本）里读令牌 |
 * | `merge` | 三条来路合一份，冲突两边都留着 |
 * | `serialize` | 档案 ⇄ 一份真正的 `DESIGN.md` |
 * | `compose` | 让模型把正文写成文（模型口也是注入的） |
 * | `check` | 产出物合不合这份规范（**只提示，不拦人**） |
 * | `context` | `brandDesignContext()` —— 四个岗位共用的那一份注入 |
 *
 * 所有出网与模型的口都是**注入的端口**，所以这一整包的测试能全用本地夹具跑完，
 * 一个字节都不出这台机器。
 */

export {
  checkAgainstDesign,
  type DesignCheckInput,
  extractColorsFromText,
} from './check.js'
export {
  chroma,
  colorDistance,
  contrastRatio,
  inPalette,
  isNeutral,
  luminance,
  NEUTRAL_CHROMA,
  nearestColor,
  normalizeColor,
  parseColor,
  type Rgb,
  SAME_COLOR_DISTANCE,
  saturation,
  toHex,
} from './color.js'
export {
  type ComposeDesignInput,
  type ComposeDesignResult,
  composeDesignProse,
  type DesignComposeModel,
  estimateComposeCredits,
} from './compose.js'
export {
  type BrandDesignContextInput,
  brandDesignContext,
  designRoleFamily,
  EMPTY_BRAND_DESIGN_CONTEXT,
} from './context.js'
export {
  type CssDecl,
  cssVariables,
  inlineStyles,
  parseCss,
  resolveVar,
  type StyleSheet,
  stripComments,
  stylesheetHrefs,
} from './css.js'
export {
  extractFileDesign,
  type FileDesignInput,
  type FileDesignResult,
  parsePrintColor,
} from './file-design.js'
export { conflictCount, editValue, mergeDesignProfile, mergeValue } from './merge.js'
export { type PdfPage, pdfPages } from './pdf.js'
export {
  type DesignProse,
  fontsOf,
  NOT_FOUND_ZH,
  type ParsedDesignMd,
  paletteOf,
  parseDesignMd,
  profileFromTokens,
  serializeDesignMd,
  tokensOf,
} from './serialize.js'
export {
  DESIGN_MAX_STYLESHEETS,
  DESIGN_PAGE_KINDS,
  type DesignPageInput,
  type DesignPageKind,
  extractSiteDesign,
  MAX_PALETTE_TOKENS,
} from './site-design.js'
export { fetchStylesheets, type SheetFetchResult, worthFetching } from './site-fetch.js'
export {
  countFactor,
  isColorProp,
  type PageRegion,
  propWeight,
  regionAt,
  regionWeight,
  type SelectorReach,
  selectorKey,
  selectorReach,
  structureWeight,
  varNameFactor,
} from './weight.js'
