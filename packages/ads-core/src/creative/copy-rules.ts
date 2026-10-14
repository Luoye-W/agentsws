/**
 * WP317（docs/101 §5.1④）：广告文案的**平台硬规矩**——条数、字数、禁用词。
 *
 * 两个子 Agent（标题 / 描述）写出来的每一条都要过这一关；过不了的照实摆出来
 * （{@link AdCopyRejection}），**不替它改**。三条纪律：
 *
 * 1. **字数按平台的口径数**。Google 的字数上限里，中日韩这类双宽字算 2 个
 *    （Google Ads 帮助「广告字数上限」那一页写的）；按「一个字算一个」数的话，
 *    15 个汉字的标题本地说没事，传上去被拒。Meta 按字符数。上限与数法读
 *    WP314 上传表那一份（`GOOGLE_RSA_LIMITS` / `META_COPY_LIMITS` / `googleTextLength`），这里不另写数。
 * 2. **不许为过审改写敏感词**。`免 费送`、`f.r.e.e`、`史-上-最`、全角字母——
 *    这些拆字、换形的写法在这里归一之后照样命中，而且单独标成「绕过」：
 *    命中了就换个说法（换卖点、换角度），不是换个写法。
 * 3. **条数是平台的事实**。Google 自适应搜索广告最多 15 条标题、4 条描述，
 *    最少 3 条与 2 条；Meta 一条广告最多 5 个标题、5 段正文（多文案选项）。
 *    多出来的不进表，摆进 `over_count`。
 */

import type {
  AdCopyField,
  AdCopyLine,
  AdCopyRejection,
  AdCreativePlatform,
} from '@agentsws/contracts'
import { AD_COPY_FORBIDDEN } from '@agentsws/core'
import { GOOGLE_RSA_LIMITS, googleTextLength, META_COPY_LIMITS } from '../sheets/validate.js'
import { checkAdCopy } from '../variants.js'

/** 一个平台一格文案的规矩。 */
export interface AdCopyFieldRule {
  /** 最多几条。 */
  max_items: number
  /** 最少几条（少于它平台不让建，或者没法组合）。 */
  min_items: number
  /** 每条最多几个字（按 {@link adCopyLength} 的口径）。 */
  max_chars: number
  /** 中文名（卡面上那一个）。 */
  zh: string
}

/**
 * 两个平台、两格（标题 / 描述）的规矩。**数只有一份**：Google 读 WP314 的
 * `GOOGLE_RSA_LIMITS`（标题 3–15 条 × 30、描述 2–4 条 × 90），Meta 字数读
 * `META_COPY_LIMITS`（标题 40、正文 125）。Meta 的条数（每轮最多 5 个标题、5 段正文，
 * 每对配成一条新广告）是流水线自己的，上传表那边一条广告只有一个标题一段正文。
 */
export const AD_COPY_RULES: Readonly<
  Record<AdCreativePlatform, Readonly<Record<AdCopyField, AdCopyFieldRule>>>
> = {
  google: {
    headline: {
      max_items: GOOGLE_RSA_LIMITS.headlines.max,
      min_items: GOOGLE_RSA_LIMITS.headlines.min,
      max_chars: GOOGLE_RSA_LIMITS.headlines.chars,
      zh: '标题',
    },
    description: {
      max_items: GOOGLE_RSA_LIMITS.descriptions.max,
      min_items: GOOGLE_RSA_LIMITS.descriptions.min,
      max_chars: GOOGLE_RSA_LIMITS.descriptions.chars,
      zh: '描述',
    },
  },
  meta: {
    headline: { max_items: 5, min_items: 1, max_chars: META_COPY_LIMITS.title, zh: '标题' },
    description: { max_items: 5, min_items: 1, max_chars: META_COPY_LIMITS.body, zh: '正文' },
  },
}

/** 按平台口径数字数：Google 用 WP314 的 `googleTextLength`（双宽字算 2）；Meta 一个字符算 1。 */
export function adCopyLength(platform: AdCreativePlatform, text: string): number {
  return platform === 'google' ? googleTextLength(text) : [...text].length
}

/** 常见的「把字母写成数字 / 符号」。只用在归一化里，不改原文。 */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
}

/**
 * 归一化：全角转半角（NFKC）、小写、去掉零宽字与一切空白和标点。
 *
 * `squash` 再把数字与符号按 {@link LEET} 换回字母——只在找「绕过」时用，
 * 正常的数字（`20%`、`3 天`）不会因此被误判为禁用词，因为直接命中那一步不用它。
 */
export function normalizeAdCopy(text: string, squash = false): string {
  const base = text.normalize('NFKC').toLowerCase().replace(/[​-‍⁠﻿]/g, '')
  const mapped = squash ? [...base].map((c) => LEET[c] ?? c).join('') : base
  return mapped.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 一条文案里撞了什么（空数组 = 干净）。 */
export interface AdCopyScanHit {
  rule: 'forbidden' | 'evasion' | 'commitment'
  term: string
}

/**
 * 查一条文案：禁用词（guardrail 的 `AD_COPY_FORBIDDEN` + 品牌自己的禁用词）、
 * 拆字绕过、承诺话术（`checkAdCopy`，与客服出站同一份词表）。
 */
export function scanAdCopy(
  text: string,
  options: { banned_terms?: readonly string[] } = {},
): AdCopyScanHit[] {
  const hits: AdCopyScanHit[] = []
  const terms = [...AD_COPY_FORBIDDEN, ...(options.banned_terms ?? [])]
    .map((t) => t.trim())
    .filter((t) => t !== '')
  const direct = text.normalize('NFKC').toLowerCase()
  const plain = normalizeAdCopy(text)
  const squashed = normalizeAdCopy(text, true)
  for (const term of terms) {
    const lower = term.toLowerCase()
    if (direct.includes(lower)) {
      hits.push({ rule: 'forbidden', term })
      continue
    }
    const key = normalizeAdCopy(term)
    if (key === '') continue
    if (plain.includes(key) || squashed.includes(normalizeAdCopy(term, true)))
      hits.push({ rule: 'evasion', term })
  }
  const commitment = checkAdCopy(text)
  for (const h of commitment.hits)
    if (!hits.some((x) => x.term === h)) hits.push({ rule: 'commitment', term: h })
  return hits
}

/** 一条候选（模型给的那一格原样）。 */
export interface AdCopyCandidateInput {
  text: string
  angle?: string
  source?: string
}

export interface ValidateCopyInput {
  platform: AdCreativePlatform
  field: AdCopyField
  candidates: readonly AdCopyCandidateInput[]
  /** 品牌禁用词（公司层技能里那一份，不在这里编）。 */
  banned_terms?: readonly string[]
  /** 已经收下的（第二轮补写时传进来，用来去重与算条数）。 */
  accepted?: readonly AdCopyLine[]
  /** 原广告里已经在跑的那几条（一字不差的不算新写的）。 */
  existing?: readonly string[]
}

export interface ValidateCopyResult {
  accepted: AdCopyLine[]
  rejected: AdCopyRejection[]
}

/**
 * 一批候选 → 收下的 + 挡下的（每条带一句人话）。
 *
 * 顺序就是模型给的顺序：先到先收，满了的摆进 `over_count`。
 */
export function validateCopyBatch(input: ValidateCopyInput): ValidateCopyResult {
  const rule = AD_COPY_RULES[input.platform][input.field]
  const accepted: AdCopyLine[] = [...(input.accepted ?? [])]
  const seen = new Set(accepted.map((l) => normalizeAdCopy(l.text)))
  for (const e of input.existing ?? []) seen.add(normalizeAdCopy(e))
  const rejected: AdCopyRejection[] = []
  const reject = (text: string, r: AdCopyRejection['rule'], reason: string): void => {
    rejected.push({ field: input.field, text, rule: r, reason })
  }

  for (const c of input.candidates) {
    const text = c.text.trim()
    if (text === '') {
      reject(c.text, 'empty', `这条${rule.zh}是空的。`)
      continue
    }
    if (/[\n\r\t]/.test(text) || /^[=@+]/.test(text)) {
      reject(
        text,
        'format',
        `这条${rule.zh}里有换行 / 制表符，或以 = @ + 开头（表格软件会当成公式）。换个写法。`,
      )
      continue
    }
    const chars = adCopyLength(input.platform, text)
    if (chars > rule.max_chars) {
      reject(
        text,
        'too_long',
        `${rule.zh}最多 ${rule.max_chars} 字${input.platform === 'google' ? '（中文一个字算 2）' : ''}，这条 ${chars}。写短一版，别指望平台截。`,
      )
      continue
    }
    const hits = scanAdCopy(text, {
      ...(input.banned_terms === undefined ? {} : { banned_terms: input.banned_terms }),
    })
    const evasion = hits.find((h) => h.rule === 'evasion')
    if (evasion !== undefined) {
      reject(
        text,
        'evasion',
        `「${evasion.term}」被拆开或换了写法。禁用词不许换个写法绕过审核——换一个卖点或角度重写。`,
      )
      continue
    }
    const forbidden = hits.find((h) => h.rule === 'forbidden')
    if (forbidden !== undefined) {
      reject(text, 'forbidden', `有禁用词「${forbidden.term}」。换个说法重写，别只删这几个字。`)
      continue
    }
    const commitment = hits.find((h) => h.rule === 'commitment')
    if (commitment !== undefined) {
      reject(
        text,
        'commitment',
        `有承诺类说法（${commitment.term}）。广告挂在付费流量上，承诺要走促销那张卡，这里别写。`,
      )
      continue
    }
    const key = normalizeAdCopy(text)
    if (seen.has(key)) {
      reject(text, 'duplicate', `和已有的一条重复了（只差标点或大小写也算）。`)
      continue
    }
    if (accepted.length >= rule.max_items) {
      reject(text, 'over_count', `${rule.zh}最多 ${rule.max_items} 条，这条排在后面。`)
      continue
    }
    seen.add(key)
    accepted.push({
      field: input.field,
      text,
      chars,
      limit: rule.max_chars,
      ...(c.source === undefined || c.source.trim() === '' ? {} : { source: c.source.trim() }),
      ...(c.angle === undefined || c.angle.trim() === '' ? {} : { angle: c.angle.trim() }),
    })
  }
  return { accepted: accepted.slice((input.accepted ?? []).length), rejected }
}
