/**
 * 退订 / 抑制名单：**全仓库只有这一份规则**（18 §3、51 §2.3）。
 *
 * 规则本身是 WP55 在 Amazon 出站硬闸里立的那一条：
 *
 * > 已退订主动消息的收件人，只能在他自己发起的那条会话线程里回复，不能新起一封。
 *
 * WP64 的邮件营销要的是同一条：一次群发是**主动外发**，名单上的人一个都不许在里面。
 * 两处调的是下面这两个函数，不各写一份——名单的口径（大小写、两端空白、加号别名）
 * 一旦在两个地方分头演化，就会出现"客服那边认为他退订了、营销这边照发"的裂缝。
 *
 * 这里不管名单**从哪来**（Klaviyo 的 suppression profiles、邮箱的退信、人手工加的），
 * 只管"给定名单，谁该被拦下"。取名单是连接器的事。
 */

/**
 * 名单比对用的归一化键。
 *
 * 只做三件保守的事：去两端空白、转小写、把 `a+tag@x.com` 归到 `a@x.com`。
 * **不**做点号归一（`a.b@gmail.com` 与 `ab@gmail.com` 在 Gmail 是同一个人，在别家不是），
 * 宁可漏归一让两条记录并存，也不能把两个真不同的人并成一个。
 */
export function suppressionKey(value: string): string {
  const trimmed = value.trim().toLowerCase()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return trimmed
  const local = trimmed.slice(0, at)
  const plus = local.indexOf('+')
  return plus < 0 ? trimmed : `${local.slice(0, plus)}${trimmed.slice(at)}`
}

/**
 * 这批收件人里，哪些人在抑制名单上（按 {@link suppressionKey} 归一后比对）。
 *
 * 返回的是**收件人那一侧的原样字符串**，不是名单里的写法——卡面上要让人认出
 * "被剔掉的是我看到的这个地址"。
 */
export function suppressedRecipients(
  recipients: readonly string[],
  suppressed: readonly string[],
): string[] {
  if (recipients.length === 0 || suppressed.length === 0) return []
  const denied = new Set(suppressed.map(suppressionKey))
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of recipients) {
    const key = suppressionKey(r)
    if (!denied.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/** 把名单上的人剔出去之后剩下的收件人（顺序不变，重复不合并）。 */
export function withoutSuppressed(
  recipients: readonly string[],
  suppressed: readonly string[],
): string[] {
  if (suppressed.length === 0) return [...recipients]
  const denied = new Set(suppressed.map(suppressionKey))
  return recipients.filter((r) => !denied.has(suppressionKey(r)))
}

/**
 * WP55 的那一条：名单上的人收不到**主动**外发。
 *
 * `reply_in_original_thread` 为真 = 这封是在对方自己发起的线程里回信，放行——
 * 退订的是"你别来找我"，不是"我问你也不许答"。
 */
export function blocksProactiveOutbound(input: {
  /** 收件人里命中名单的人数（0 = 一个都没有）。 */
  suppressed_hits: number
  /** 这封是不是在对方发起的原线程里回复。 */
  reply_in_original_thread?: boolean
}): boolean {
  return input.suppressed_hits > 0 && input.reply_in_original_thread !== true
}
