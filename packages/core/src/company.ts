/**
 * 46 §2 I1：公司名归一化与 `company_key`（纯函数）。
 *
 * 它决定"两台机器算不算同一家公司"，所以住在这里而不是某个进程里：
 * 服务进程（`apps/server/src/onboarding.ts`）拿它算局域网 TXT 里的那把钥匙，
 * 模拟回路（`packages/simulation`）拿**同一个函数**演"两个人写法不同但是同一家"。
 * 两边各写一份的话，那条模拟题就只是在测它自己。
 *
 * 三条纪律：
 *
 * 1. **纯**。不碰时钟、不碰随机源、不读库——同一个输入在两台机器上必须算出同一个值。
 * 2. **只剥公司形式，不剥行业词**。「科技」「实业」「贸易」是名字的一部分。
 * 3. **全称只进哈希**。归一化后的串与全称都不出本机，出去的只有 `companyKey` 的结果
 *    （46 §2 I1）。
 */
import { sha256 } from './snapshot.js'

/**
 * 公司形式的尾缀表（46 §2 I1「去空格、大小写、全半角、'有限公司 / Co., Ltd.' 这类尾缀」）。
 *
 * 中文那一组按 `endsWith` 剥（中文本来就不分词）；拉丁那一组按**词**剥——
 * 不按词就会把 "Visa" 剥成 "Vi"（尾缀表里有 `sa`）。长的排在前面，
 * 剥完再来一轮，所以"集团股份有限公司"会一路剥到"集团"为止。
 *
 * 只剥**公司形式**，不剥行业词：「科技」「实业」「贸易」留着，它们是名字的一部分。
 */
const CJK_SUFFIXES: readonly string[] = [
  '股份有限责任公司',
  '股份有限公司',
  '有限责任公司',
  '责任有限公司',
  '有限公司',
  '股份公司',
  '有限会社',
  '合同会社',
  '株式会社',
  '公司',
]

/** 拉丁尾缀（已小写、逗号句点已变空格）。多词的排在单词前面。 */
const LATIN_SUFFIXES: readonly string[][] = [
  ['company', 'limited'],
  ['co', 'limited'],
  ['co', 'ltd'],
  ['pte', 'ltd'],
  ['pty', 'ltd'],
  ['incorporated'],
  ['corporation'],
  ['company'],
  ['limited'],
  ['corp'],
  ['inc'],
  ['ltd'],
  ['llc'],
  ['llp'],
  ['plc'],
  ['gmbh'],
  ['sarl'],
  ['sas'],
  ['spa'],
  ['srl'],
  ['pte'],
  ['pty'],
  ['nv'],
  ['bv'],
  ['ag'],
  ['sa'],
  ['kk'],
  ['co'],
]

/** 全角 → 半角（FF01–FF5E 整段平移；U+3000 表意空格 → 普通空格）。 */
function toHalfWidth(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0)
    else out += ch
  }
  return out
}

/**
 * 公司名归一化。同一家公司，一个人写全称、另一个人多打了空格还加了"有限公司"，
 * 归一化之后必须是同一个串——`companyKey` 就是拿它算的。
 *
 * 顺序有讲究：**先分词剥尾缀，最后才去空格**。反过来做的话 "Co., Ltd." 会先粘成
 * "coltd"，再想按词剥就无从下手了。
 */
export function normalizeCompanyName(raw: string): string {
  // ① 全半角统一 → ② 大小写统一
  let s = toHalfWidth(raw).toLowerCase()
  // ③ 分隔性标点变空格（逗号、句点、顿号、间隔号），折叠空白
  s = s
    .replace(/[,.、·]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // ④ 反复剥公司形式尾缀，剥到不动为止；剥空了就不剥（"有限公司"本身是个名字）
  for (let round = 0; round < 8; round += 1) {
    const next = stripOneSuffix(s)
    if (next === s) break
    s = next
  }
  // ⑤ 剩下的空白与括号 / 连字符一律去掉（"NordVolt Gear" 与 "NordVolt-Gear" 同一家）
  return s.replace(/[\s()[\]{}<>\-_'"&/\\|]/g, '')
}

function stripOneSuffix(s: string): string {
  for (const suffix of CJK_SUFFIXES) {
    if (s.endsWith(suffix) && s.length > suffix.length) return s.slice(0, -suffix.length).trim()
  }
  const tokens = s.split(' ').filter((t) => t !== '')
  for (const suffix of LATIN_SUFFIXES) {
    if (tokens.length <= suffix.length) continue
    const tail = tokens.slice(tokens.length - suffix.length)
    if (tail.every((t, i) => t === suffix[i])) return tokens.slice(0, -suffix.length).join(' ')
  }
  return s
}

/**
 * 域名归一化：去协议、去 `@`、去 `www.`、去尾斜杠、小写。
 * 用户从登录邮箱带出来的多半是 `nordvolt.cn`，但手填时什么都可能出现。
 */
export function normalizeDomain(raw: string | undefined): string {
  if (raw === undefined) return ''
  let s = toHalfWidth(raw).trim().toLowerCase()
  s = s.replace(/^[a-z]+:\/\//, '')
  s = s.replace(/^.*@/, '')
  s = s.replace(/^www\./, '')
  s = s.replace(/\/.*$/, '')
  return s
}

/**
 * 46 §2 I1 的"同一家公司"钥匙：`sha256(归一化名 + '|' + 域名小写)`。
 *
 * 两台机器算出同一个值 = 强匹配（名字与域名都对上）；没填域名时域名那一半是空串，
 * 算出来的仍是一个合法的 key，只是它只代表弱匹配——**这不改变任何事**，
 * 因为看见从来不等于连上（46 I1 第二条）。
 */
export function companyKey(legal_name: string, domain?: string): string {
  return sha256(`${normalizeCompanyName(legal_name)}|${normalizeDomain(domain)}`)
}
