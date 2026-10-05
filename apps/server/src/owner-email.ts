/**
 * WP233：本机负责人（owner）的登录邮箱跟云账号对齐。
 *
 * 本机模式没给 `AGENTSWS_OWNER_EMAIL` 时，服务进程拿占位邮箱 `owner@localhost` 建 owner
 * ——它只是一个内部键。Luoye 10-05 真机：第 ① 步填了云账号邮箱，第 ② 步却显示
 * 「登录邮箱：owner@localhost」，看着像第 ① 步没生效。所以关联上云账号之后，
 * owner 的邮箱改成那个云账号邮箱。
 *
 * 四条规矩：
 *
 * 1. **只改占位**：owner 的邮箱已经不是占位（用户自己配过 / 已经对齐过）就一个字不动。
 *    于是这件事可以反复跑——第二次跑什么也不发生。
 * 2. **人的 id 不变**：成员、分配、会话、审计都按 `person_id` 记，一条都不断。旧的占位地址
 *    留成别名（`keep_old_as_alias`）：启动时按占位邮箱认 owner、桌面壳拿占位邮箱换会话，
 *    照常认到同一个人。
 * 3. **新邮箱已经是别人的就不改**（本机已经有一位同事用这个邮箱）——两个人不能共用一个登录邮箱。
 * 4. **记审计**：`person.email_changed`，payload 只有两头的域名（21 §1，与 `cloud.account_linked` 同一条纪律）。
 */
import type { LocalIdentityService } from '@agentsws/api'
import {
  type EventEnvelope,
  emailDomain,
  isPlaceholderOwnerEmail,
  type PersonEmailChangedPayload,
  type PersonId,
  type WorkspaceId,
} from '@agentsws/contracts'

export type OwnerEmailReason = PersonEmailChangedPayload['reason']

/** 这一次对齐的结果（测试与诊断用；不含邮箱本身）。 */
export type OwnerEmailOutcome =
  /** 改了。 */
  | 'changed'
  /** 没关联云账号（或读不出那个邮箱）：什么也不做。 */
  | 'not_linked'
  /** owner 的邮箱已经不是占位：不动（用户改过的、已经对齐过的都在这一档）。 */
  | 'not_placeholder'
  /** 云账号邮箱已经是本机另一个人的：不改。 */
  | 'taken'
  /** 找不到 owner / 身份服务不支持改邮箱。 */
  | 'unsupported'

export interface AlignOwnerEmailOptions {
  identity: Pick<LocalIdentityService, 'getPerson' | 'personByEmail' | 'changePersonEmail'>
  owner_id: PersonId
  workspace_id: WorkspaceId
  /** 现在关联着的云账号邮箱；没关联就 `undefined`。 */
  cloudEmail: () => Promise<string | undefined>
  appendEvent: (e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }) => void
}

export async function alignOwnerEmail(
  options: AlignOwnerEmailOptions,
  reason: OwnerEmailReason,
): Promise<OwnerEmailOutcome> {
  const target = (await options.cloudEmail())?.trim().toLowerCase()
  if (target === undefined || target === '' || !target.includes('@')) return 'not_linked'
  const owner = await options.identity.getPerson(options.owner_id)
  if (owner === undefined || typeof options.identity.changePersonEmail !== 'function')
    return 'unsupported'
  if (!isPlaceholderOwnerEmail(owner.email)) return 'not_placeholder'
  const holder = options.identity.personByEmail(target)
  if (holder !== undefined && holder.id !== owner.id) return 'taken'
  await options.identity.changePersonEmail(owner.id, target, { keep_old_as_alias: true })
  const payload: PersonEmailChangedPayload = {
    person_id: owner.id,
    from_domain: emailDomain(owner.email),
    to_domain: emailDomain(target),
    reason,
  }
  options.appendEvent({
    schema_version: 1,
    workspace_id: options.workspace_id,
    type: 'person.email_changed',
    actor: { kind: 'system', id: 'cloud-account' },
    correlation: { trace_id: `tr_owner_email_${owner.id}` },
    payload,
  })
  return 'changed'
}
