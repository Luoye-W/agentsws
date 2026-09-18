/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：**文件地址**——
 * 第三栏注册表那套 `matches` / `canOpen` 判的就是这一个串。
 *
 * 形照官方（`dsh-resource://file/**` + `*.md` 这种 glob），前缀换成我们的
 * `agentsws://`。地址是 `agentsws://file/<source_id>/<文件名>`：
 *
 * **为什么文件名要写进地址。** 注册表的 `canOpen()` 只拿得到地址
 * （`registry.ts` 的 `PanelOpenScope`），而"这个面板开不开得了"这件事**取决于扩展名**——
 * 光有 `src_abc` 判不出它是 .docx 还是 .zip。官方那一侧靠的是同一件事：
 * 它的 patterns 里写着 `*.md`，也就是说地址末尾本来就是文件名。
 *
 * 不把扩展名写进地址的两种做法都更差：① 面板先开了再去问"这是什么文件"，
 * 于是 .zip 也会开出一个面板再说"不支持"（那时候人已经看见一个空抽屉了）；
 * ② 在调用点判一遍扩展名再决定开不开——那是把注册表的排序规则抄了第二遍，
 * 两遍迟早不一致。
 *
 * **这个文件不许 import 任何渲染库。** 它被 `builtin-panels.tsx` 在**启动时**引用
 * （`canOpen` 是第一段、静态的），一旦它拖进 `xlsx`，"启动不激活"（#6）当场作废。
 */

export const FILE_ADDRESS_PREFIX = 'agentsws://file/'

/** 注册表里那一条 glob。 */
export const FILE_ADDRESS_PATTERN = 'agentsws://file/**'

/** 这一栏认得的三种；别的扩展名一律不接，交给"下载"。 */
export type OfficeKind = 'word' | 'sheet' | 'slides'

/**
 * 扩展名 → 用哪一种渲染。
 *
 * `.doc` / `.ppt` / `.xls`（2003 之前的 OLE 复合文档）**不在表里**：纯 JS 解析
 * 它们要另一套复合文档的实现，而我们没有。列进来再在面板里说"打不开"，
 * 不如一开始就让 `canOpen` 回假、让人去下载。
 *
 * **WP99 把 `.xls` 从这张表里去掉了。** WP97 时表格走的是 SheetJS，它连老 xls
 * 也解；换成 `exceljs@4.4.0` 之后（理由见 `sheet-view.tsx` 顶上）只剩 OOXML，
 * 老 xls **解不了**。与其让面板开出来再说一句"坏了"，不如一开始就不接——
 * 知识库页那一行会写明"这是老格式，下载下来用 Excel 打开"（见 `isLegacyOfficeFile`）。
 */
const BY_EXTENSION: Readonly<Record<string, OfficeKind>> = {
  docx: 'word',
  xlsx: 'sheet',
  csv: 'sheet',
  pptx: 'slides',
}

/**
 * 2003 之前的三种老格式。
 *
 * 单列出来只为了**界面上能说人话**：同样是"不预览"，`.zip` 与 `.xls` 的原因不一样——
 * 前者是"这一栏不管这种文件"，后者是"这个格式太老了，浏览器里解不动"。
 */
const LEGACY_OFFICE: ReadonlySet<string> = new Set(['xls', 'doc', 'ppt'])

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i < 0 ? '' : filename.slice(i + 1).toLowerCase()
}

export function officeKindOf(filename: string): OfficeKind | undefined {
  return BY_EXTENSION[extensionOf(filename)]
}

/** 是不是 2003 之前的老 Office 格式（知识库页据此换一句提示）。 */
export function isLegacyOfficeFile(filename: string): boolean {
  return LEGACY_OFFICE.has(extensionOf(filename))
}

export interface FileAddress {
  source_id: string
  /** 地址里带的文件名；只有 id 那一档是 `undefined`。 */
  filename?: string
}

/** 拼一个地址（知识库页点文件那一行用的就是它）。 */
export function fileAddress(source_id: string, filename: string): string {
  return `${FILE_ADDRESS_PREFIX}${encodeURIComponent(source_id)}/${encodeURIComponent(filename)}`
}

/**
 * 拆一个地址。不是文件地址 / 没有 id → `undefined`。
 *
 * 两段都 `decodeURIComponent`（拼的时候编过），坏串当没有——地址是从
 * 本机布局与调用点来的，但"坏了就抛"会让整条第三栏跟着白屏。
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const rest = address.slice(FILE_ADDRESS_PREFIX.length)
  if (rest === '') return undefined
  const slash = rest.indexOf('/')
  const rawId = slash < 0 ? rest : rest.slice(0, slash)
  const rawName = slash < 0 ? '' : rest.slice(slash + 1)
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  }
  const source_id = decode(rawId)
  if (source_id === '') return undefined
  const filename = decode(rawName)
  return filename === '' ? { source_id } : { source_id, filename }
}

/**
 * 注册表的 `canOpen`：**只认那五种扩展名**。
 *
 * 地址里没有文件名时回**假**——判不出来就不接，让调用方走它的兜底（下载）。
 * "判不出来先接下来再说"会把一个空抽屉甩到人脸上。
 */
export function canOpenOfficeFile(scope: { address?: string }): boolean {
  const address = scope.address
  if (address === undefined) return false
  const parsed = parseFileAddress(address)
  if (parsed?.filename === undefined) return false
  return officeKindOf(parsed.filename) !== undefined
}
