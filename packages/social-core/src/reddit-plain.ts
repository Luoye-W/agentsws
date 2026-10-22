/**
 * WP468（决策 1510，WP467 真站发现）：**Reddit 草稿去 Markdown 记号**——出卡前的那道保险。
 *
 * 新版 Reddit 的评论框是富文本：草稿里的 `**粗体**`、`[字](链接)`、`# 标题` 会照符号原样发出去。
 * 起草那一步已经叫模型别写 Markdown（链接直接写完整网址、分段用空行）；这里兜住它没听的那几处：
 *
 * | 草稿里 | 变成 |
 * |---|---|
 * | `**x**` / `__x__` / `***x***` | `x` |
 * | `*x*` / `_x_`（两边不是字母数字，`u/some_user` 不动） | `x` |
 * | `~~x~~` / `` `x` `` | `x` |
 * | `[x](url)` / `![x](url)` | `x (url)`；字就是网址（或是空的）时只留 `url` |
 * | `<https://…>` | `https://…` |
 * | 行首 `# ` … `###### ` | 去掉记号，留那一行字 |
 * | 代码块的 ```` ``` ```` 行 | 去掉那一行，里面的字留着 |
 * | `\*` 这类转义 | `*` |
 *
 * 网址本身一个字都不动（`https://x.com/a__b__c` 里的 `__` 不当粗体）。列表的「- 」、引用的「> 」不动——
 * 富文本里照原样显示也读得通。纯函数：不调模型、不联网。
 */

const PH_OPEN = ''
const PH_CLOSE = ''

/** 网址里允许一层括号（维基那种 `…/Foo_(bar)`）。 */
const URL_BODY = String.raw`(?:[^\s()<>]|\([^\s()<>]*\))+`
const MD_LINK = new RegExp(
  String.raw`!?\[([^\]\n]*)\]\(\s*<?(${URL_BODY})>?(?:\s+"[^"\n]*")?\s*\)`,
  'gu',
)
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/gu
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>]+/gu
/** 网址末尾跟着的标点不算网址（句号、逗号、右括号这类）。 */
const TRAILING_PUNCT = /[.,;:!?'")\]」』）。，；：！？]+$/u

const sameUrl = (label: string, url: string): boolean => {
  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//u, '')
      .replace(/^www\./u, '')
      .replace(/\/+$/u, '')
  return norm(label) === norm(url)
}

/** Reddit 草稿里残留的 Markdown 记号转成纯文字（见文件头那张表）。 */
export function redditPlainText(input: string): string {
  const saved: string[] = []
  const keep = (url: string): string => {
    saved.push(url)
    return `${PH_OPEN}${saved.length - 1}${PH_CLOSE}`
  }
  let s = input.replace(/\r\n?/gu, '\n')
  // 代码块的围栏行去掉（里面的字留着）
  s = s.replace(/^[ \t]*(?:```|~~~)[^\n]*$\n?/gmu, '')
  // [字](链接) → 字 (链接)；字就是网址 / 空的 → 只留网址
  s = s.replace(MD_LINK, (_m, label: string, url: string) => {
    const text = label.trim()
    return text === '' || sameUrl(text, url) ? keep(url) : `${text} (${keep(url)})`
  })
  s = s.replace(AUTOLINK, (_m, url: string) => keep(url))
  // 剩下的裸网址先藏起来，后面去记号时不碰它
  s = s.replace(BARE_URL, (m) => {
    const tail = m.match(TRAILING_PUNCT)?.[0] ?? ''
    const url = tail === '' ? m : m.slice(0, -tail.length)
    return url === '' ? m : `${keep(url)}${tail}`
  })
  // 行首标题记号
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gmu, '$1')
  // 粗体 / 删除线 / 行内代码（同一行里成对的才算）
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/gu, '$1')
  s = s.replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu, '$1')
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/gu, '$1')
  s = s.replace(/`([^`\n]+)`/gu, '$1')
  // 斜体：两边不是字母数字（`5 * 3`、`u/some_user_name` 不动）
  s = s.replace(/(?<![\p{L}\p{N}*\\])\*(?=[^\s*])([^*\n]*?[^\s*\\])\*(?![\p{L}\p{N}*])/gu, '$1')
  s = s.replace(/(?<![\p{L}\p{N}_\\])_(?=[^\s_])([^_\n]*?[^\s_\\])_(?![\p{L}\p{N}_])/gu, '$1')
  // 转义（`\*` → `*`）
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/gu, '$1')
  // 行尾空格（Markdown 的硬换行写法）去掉；三个以上换行收成一个空行
  s = s.replace(/[ \t]+$/gmu, '').replace(/\n{3,}/gu, '\n\n')
  s = s.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'gu'),
    (_m, i: string) => saved[Number(i)] ?? '',
  )
  return s.trim()
}

/** 标题只有一行：同一套规矩，换行收成空格。 */
export function redditPlainTitle(input: string): string {
  return redditPlainText(input).replace(/\s*\n+\s*/gu, ' ')
}
