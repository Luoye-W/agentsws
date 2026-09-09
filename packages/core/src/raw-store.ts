/**
 * 受控原始材料区的**端口**（18 §2.1 + 21 §4 + 31 §4）。
 *
 * 原始 MIME、附件字节、会议录音只落这里，别处只拿 `ref`。三条纪律由实现兑现——
 * 加密、保留期、随主体删除；**这里的内容永不进模型**，也永不进事件日志。
 *
 * 为什么在 core：`@agentsws/channels` 与 `@agentsws/meetings` 各自维护过一份同形状的
 * 定义（WP13 / WP23 的遗留），两份跑偏就是两套纪律。端口上移到这里，两个包各自只留实现，
 * **表仍然不共享**（35 §2：邮件原文落 channels 的库，录音落 meetings 的库）。
 */
import type { Iso8601, MaybePromise } from '@agentsws/contracts'

/** 一条原始材料的公共形状；各包按自己的域补字段（渠道名 / 工作区 / 种类）。 */
export interface RawRecordBase {
  /** `raw://…`，指回这条材料 */
  ref: string
  stored_at: Iso8601
  /** 文本类（MIME 源、转写、文档）用 string；字节用 Uint8Array */
  payload: string | Uint8Array
  mime?: string
  name?: string
  /** 落库前已按宿主的秘密策略脱敏（文本类） */
  secrets_scrubbed?: boolean
  /**
   * 21 §4「随主体删除」：这条材料是**谁**的（客户 id / 参会人 id / 邮箱地址…）。
   *
   * 有 {@link RawCipher} 时它同时是加密的 AAD 与密钥选择依据——没有 subject_ref
   * 的材料落库时就是明文（比如系统自己的日志附件），这不是漏洞，是「没有主体可绑」。
   */
  subject_ref?: string
  /** 读出来时主体密钥已销毁：行还在，内容读不出来了。 */
  erased?: true
}

/**
 * 受控原始材料区的**加密端口**（18 §2.1 三条纪律里的第一条）。
 *
 * 实现在 `@agentsws/data` 的 `SubjectKeyring`——每个主体一把独立随机、
 * 不可从主密钥重派生的密钥，`shred` 即 crypto-shredding。
 * 端口在这里，是因为 `@agentsws/channels` 与 `@agentsws/meetings`
 * **不共享 data 的表**（35 §2），只能靠一个接口把密钥环接进来。
 *
 * 三条实现约束：
 * 1. `seal` 对已销毁的主体必须**抛**（销毁过的主体不能又发新钥，否则删除可被下一次写入撤销）；
 * 2. `open` 解不开一律 `undefined`，不抛、不返回半截；
 * 3. AAD 绑 `subject`：把一条密文搬到另一个主体名下必须解不开。
 */
export interface RawCipher {
  seal(subject: string, plaintext: Uint8Array): Uint8Array
  open(subject: string, sealed: Uint8Array): Uint8Array | undefined
  /** 销毁主体密钥；返回销毁时间。幂等。 */
  shred(subject: string, at?: string): string
  isShredded(subject: string): boolean
}

/**
 * 最小端口：写、读、（可选）就地脱敏。
 *
 * 保留期与随主体删除是**域相关**的（会议按 workspace 存、渠道按 channel 存），
 * 所以 `erase` / `prune` 不在这个最小面上——需要的包在自己的接口里加（见 meetings）。
 */
export interface RawStorePort<R extends RawRecordBase = RawRecordBase> {
  put(input: Omit<R, 'ref'>): MaybePromise<string>
  get(ref: string): MaybePromise<R | undefined>
  /** 落库后才发现秘密时的就地脱敏（`redact` 由调用方给，端口不认识秘密模式表） */
  scrub?(ref: string, redact: (text: string) => string): MaybePromise<void>
}
