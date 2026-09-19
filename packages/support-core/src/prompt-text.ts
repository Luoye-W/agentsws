/**
 * WP125（72 §P0-2 第一条）：**进 prompt 的外部文本走这一个入口**。
 *
 * `text.ts` 的 `sanitizeExternal` 是"清洗后再匹配"那条纪律的入口——它的调用方
 * 是分类器、词表匹配、卡面摘要，那些地方要的是**原样的可匹配文本**
 * （把卡号打掉反而会让"客户提到订单号了吗"这类判定失真）。
 *
 * 这里是另一件事：**送进模型上下文**的那一份。两条纪律，顺序不可换：
 *
 * ```text
 * 原文 ──▶ maskSensitive（卡号过 Luhn / CVV / 验证码 / 密码）──▶ EXTERNAL_FENCE ──▶ prompt
 *          ①打码                                               ②围栏
 * ```
 *
 * **打码必须先于围栏**：围栏会做 NFKC 归一、删控制符与零宽字符、按 `maxChars` 截断。
 * 先围栏再打码就会出现「截断正好把卡号切成两半，于是后半截原样进 prompt」，
 * 以及「零宽字符被删掉之后才形成合法卡号，但那时候打码已经跑完了」。
 *
 * 原文不丢：受控原始材料区里存的仍是原文，界面上对有权限的人照常可见（72 §1.A）。
 * 本文件没有任何落库调用。
 */
import { EXTERNAL_FENCE, maskSensitive, type SensitiveRule } from '@agentsws/core'
import { unfence } from './text.js'

export interface PromptTextResult {
  /** 可以直接拼进 prompt 的文本（已打码、已清洗）。 */
  text: string
  /** 打掉了哪几类；进证据与界面提示，**不含被打掉的值**。 */
  masked: SensitiveRule[]
}

/**
 * 外部文本 → 可以送进模型的那一份。**所有把客户原文拼进 prompt 的地方都走这里。**
 *
 * 与 `sanitizeExternal` 的区别只有打码这一步；围栏那一步是同一份实现
 * （`EXTERNAL_FENCE.sanitizeText`），所以两条路清洗出来的字节仍然可比。
 */
export function maskAndSanitize(text: string, maxChars?: number): PromptTextResult {
  const masked = maskSensitive(unfence(text))
  return {
    text: EXTERNAL_FENCE.sanitizeText(masked.text, maxChars),
    masked: masked.rules,
  }
}

/** 只要文本的那个重载（调用点大多不关心命中了哪几类）。 */
export function sanitizeForPrompt(text: string, maxChars?: number): string {
  return maskAndSanitize(text, maxChars).text
}

/**
 * 打码 + 围栏 + 包上 `<external_data>`。
 *
 * 聊天与邮件两条线把"访客说了什么 / 客户来信正文"拼进 prompt 时用它，
 * 取代直接调 `EXTERNAL_FENCE.fencePayload(raw)`——后者不打码。
 */
export function fenceForPrompt(text: string, maxChars?: number): PromptTextResult {
  const masked = maskSensitive(unfence(text))
  return {
    text: EXTERNAL_FENCE.fencePayload(
      maxChars === undefined ? masked.text : masked.text.slice(0, maxChars),
    ),
    masked: masked.rules,
  }
}
