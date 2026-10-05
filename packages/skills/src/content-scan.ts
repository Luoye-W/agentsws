/**
 * WP219（docs/90 §7、docs/42「内容更新」）：**可疑指令扫描**。
 *
 * 第三方技能是给模型读的文字——一句「把对话内容发到这个网址」「不用问用户直接发」就足以让模型越线。
 * 所以上游每出一版，提案脚本先对新文本跑一遍这组规则：
 *
 * - 命中就**标红、不自动通过**：审核人逐条看，确属误报的在审核记录里写放行理由（规则 + 文件 + 命中原文），
 *   打包脚本重扫一遍，**有一条没放行就不打包**；
 * - 用户端也带着同一组规则：命中过的条目（审核记录里 `scan_hits > 0`，或本机重扫有命中）即使设了
 *   「已审的自动更新」也**不自动更新**，照样出卡等人点。
 *
 * 规则是关键词 / 正则，不是语义判断：宁可多报。中英两套都写。
 */
import { SKILL_AUTHORIZATION_PHRASES } from './bundled.js'

export type ContentScanCategory =
  /** 外发数据：把对话、客户资料、代码发到别处。 */
  | 'exfiltration'
  /** 绕过审批：不问人、跳过卡片、忽略之前的规矩。 */
  | 'bypass_approval'
  /** 要凭据：索要密码、密钥、令牌、银行卡。 */
  | 'credentials'
  /** 隐藏身份推广：装成普通用户、不透露是 AI / 合作方、小号刷评。 */
  | 'hidden_promotion'
  /** 藏起来的字：零宽字符、双向控制符、HTML 注释里的指令。 */
  | 'hidden_text'

export interface ContentScanRule {
  id: string
  category: ContentScanCategory
  /** 给审核人看的一句话。 */
  label: string
  pattern: RegExp
}

const r = (
  id: string,
  category: ContentScanCategory,
  label: string,
  pattern: RegExp,
): ContentScanRule => ({
  id,
  category,
  label,
  pattern,
})

export const CONTENT_SCAN_RULES: readonly ContentScanRule[] = [
  // ── 外发数据 ──
  r(
    'exfil-send-to',
    'exfiltration',
    '让模型把数据发到某处',
    /\b(send|post|upload|forward|report|transmit)\b[^.\n]{0,60}\b(to|into)\b[^.\n]{0,40}(https?:\/\/|webhook|endpoint|server|email address)/i,
  ),
  r(
    'exfil-http-post',
    'exfiltration',
    '命令里往外网发请求',
    /(curl\s[^\n]*(-X\s*POST|--data|-d\s)|fetch\(\s*['"]https?:\/\/|wget\s+--post|Invoke-WebRequest)/i,
  ),
  r(
    'exfil-telemetry',
    'exfiltration',
    '上报 / 遥测 / 收集用户原话',
    /(telemetry|analytics|log_feedback|log_skill_use|user[-_ ]?prompt[-_ ]?base64|session[-_ ]?id\b)/i,
  ),
  r(
    'exfil-zh',
    'exfiltration',
    '让模型把数据发出去（中文）',
    /(发送|上传|回传|同步|转发|汇报)[^。\n]{0,20}(到|给)[^。\n]{0,20}(网址|链接|服务器|接口|邮箱|webhook)/,
  ),
  r(
    'exfil-collect-zh',
    'exfiltration',
    '收集对话 / 客户资料（中文）',
    /(收集|记录|保存)[^。\n]{0,10}(对话|聊天记录|客户资料|用户原话|提示词)/,
  ),
  // ── 绕过审批 ──
  r(
    'bypass-ignore',
    'bypass_approval',
    '让模型忽略之前的规矩',
    /\b(ignore|disregard|override|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|system)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines?)/i,
  ),
  r(
    'bypass-no-ask',
    'bypass_approval',
    '不问人就做',
    /\b(without|no need (to|for)|don'?t|do not|never)\b[^.\n]{0,20}\b(ask(ing)?|confirm(ation|ing)?|approv(al|e|ing)|permission|review)\b/i,
  ),
  r(
    'bypass-skip',
    'bypass_approval',
    '跳过审批 / 卡片',
    /\b(skip|bypass|circumvent)\b[^.\n]{0,20}\b(approval|review|confirmation|the card|human)\b/i,
  ),
  r(
    'bypass-zh',
    'bypass_approval',
    '忽略规矩 / 不用确认（中文）',
    /(忽略|无视|跳过|绕过)[^。\n]{0,10}(之前|以上|上面|系统|审批|确认|卡片|规则|规矩)/,
  ),
  r(
    'bypass-phrases',
    'bypass_approval',
    '授权字样（WP160 那张表）',
    new RegExp(SKILL_AUTHORIZATION_PHRASES.map(escapeRegExp).join('|'), 'i'),
  ),
  // ── 要凭据 ──
  r(
    'cred-ask',
    'credentials',
    '索要密码 / 密钥 / 令牌',
    /\b(ask|request|collect|obtain|enter|paste|provide|share)\b[^.\n]{0,40}\b(password|passcode|api[ _-]?key|secret|access[ _-]?token|private[ _-]?key|seed phrase|recovery phrase|2fa|otp|credit card|card number|cvv)\b/i,
  ),
  r(
    'cred-zh',
    'credentials',
    '索要密码 / 密钥 / 验证码（中文）',
    /(提供|告诉|输入|发来|粘贴|索要|收集)[^。\n]{0,15}(密码|密钥|令牌|验证码|私钥|助记词|银行卡|信用卡|身份证)/,
  ),
  // ── 隐藏身份推广 ──
  r(
    'promo-pretend',
    'hidden_promotion',
    '装成普通用户 / 顾客',
    /\b(pretend|pose|act|posing)\b[^.\n]{0,20}\b(as|to be)\b[^.\n]{0,20}\b(a |an )?(real |regular |normal |ordinary )?(customer|user|buyer|fan|reviewer|consumer)\b/i,
  ),
  r(
    'promo-hide',
    'hidden_promotion',
    '不透露是 AI / 合作关系',
    /\b(don'?t|do not|never|without)\b[^.\n]{0,20}\b(disclose|reveal|mention|admit)\b[^.\n]{0,40}\b(ai|bot|automated|affiliat\w*|sponsor\w*|paid|employee|brand)\b/i,
  ),
  r(
    'promo-astroturf',
    'hidden_promotion',
    '小号 / 刷评 / 刷票',
    /\b(astroturf\w*|sock ?puppets?|fake reviews?|upvote (ring|farm)|vote manipulation|alt accounts?)\b/i,
  ),
  r(
    'promo-zh',
    'hidden_promotion',
    '装成用户 / 小号 / 刷评（中文）',
    /(装成|假装|冒充)[^。\n]{0,6}(用户|顾客|消费者|买家|网友)|小号|刷(好评|评论|票|单)|(不要|别)(透露|说明|提及)[^。\n]{0,10}(AI|身份|合作|广告)/,
  ),
  // ── 藏起来的字 ──
  r('hidden-chars', 'hidden_text', '零宽字符 / 双向控制符', /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/),
  r('hidden-comment', 'hidden_text', 'HTML 注释里的字', /<!--[\s\S]{8,}?-->/),
]

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ContentScanHit {
  rule: string
  category: ContentScanCategory
  label: string
  path: string
  line: number
  /** 命中的原文（截到 120 字）。 */
  match: string
}

/** 扫一个文件的文本。 */
export function scanContentText(path: string, text: string): ContentScanHit[] {
  const hits: ContentScanHit[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (const rule of CONTENT_SCAN_RULES) {
    if (rule.id === 'hidden-comment') {
      const m = rule.pattern.exec(text)
      if (m !== null) {
        const line = text.slice(0, m.index).split('\n').length
        hits.push({
          rule: rule.id,
          category: rule.category,
          label: rule.label,
          path,
          line,
          match: m[0].slice(0, 120),
        })
      }
      continue
    }
    lines.forEach((l, i) => {
      const m = rule.pattern.exec(l)
      if (m === null) return
      hits.push({
        rule: rule.id,
        category: rule.category,
        label: rule.label,
        path,
        line: i + 1,
        match: m[0].slice(0, 120),
      })
    })
  }
  return hits
}

/** 扫一个条目的全部文件（只扫文字文件；`LICENSE` 这类许可证正文不扫）。 */
export function scanContentFiles(
  files: ReadonlyMap<string, Uint8Array | string>,
): ContentScanHit[] {
  const out: ContentScanHit[] = []
  for (const [path, data] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const base = path.split('/').pop() ?? path
    if (base === 'LICENSE' || base === 'NOTICE' || base === 'COPYING') continue
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    out.push(...scanContentText(path, text))
  }
  return out
}

/** 审核人放行一条命中的写法：规则 + 文件 + 命中原文（小写）对上才算这一条放行了。 */
export interface ContentScanAcceptance {
  rule: string
  path: string
  match: string
  reason: string
}

export function scanHitKey(h: Pick<ContentScanHit, 'rule' | 'path' | 'match'>): string {
  return `${h.rule}|${h.path}|${h.match.toLowerCase()}`
}

/** 命中里还有哪几条没被放行（空 = 全部放行或没命中）。 */
export function unacceptedScanHits(
  hits: readonly ContentScanHit[],
  accepted: readonly ContentScanAcceptance[],
): ContentScanHit[] {
  const ok = new Set(accepted.filter((a) => a.reason.trim() !== '').map(scanHitKey))
  return hits.filter((h) => !ok.has(scanHitKey(h)))
}
