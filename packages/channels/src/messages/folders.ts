/**
 * WP161（Luoye 09-27）：**岗位文件夹认已有的真名，不分大小写**。
 *
 * 规范名与 Luoye 的老产品逐字相同：客服 `KefuAgents`（KefuAgent）、红人 `KOLAgents`
 * （KOLAgents），B2B 预留 `BtoBAgents`。很多 IMAP 服务器文件夹名区分大小写——
 * 用过老产品（或 agentsws 早先的全小写 `kefuagents`）的人接进来，要是我们照规范名
 * 另建一只，邮箱里就会出现两只名字相近的文件夹、信分在两处。
 *
 * 所以每只邮箱**先列服务器上的文件夹**，再按下面这条规矩挑：
 *
 * 1. 有规范名那只（大小写逐字相同）→ 用它；
 * 2. 没有规范名、但有任何大小写变体（`kefuagents` / `KEFUAGENTS`）→ **沿用那个真名**；
 * 3. 都没有 → 用规范名（第一次挪信时由回写端新建）。
 *
 * 多个变体同时存在时第 1 条优先，其余变体**照常扫描**——信不挪、不删、不改名。
 * 那是用户邮箱里的结构，我们没有资格替他合并。
 *
 * 这里全是纯函数：列文件夹是宿主的事（每个账号各列各的、各缓存各的）。
 */

import {
  BTOBAGENTS_FOLDER,
  KOL_FOLDER,
  type MessageFolderKind,
  type MessageRoute,
  SUPPORT_FOLDER,
} from '@agentsws/contracts'

/** 有岗位文件夹的那几种语义。 */
export type AgentFolderKind = 'support' | 'kol' | 'b2b'

/** 语义 → 规范名。 */
export const AGENT_FOLDERS: Readonly<Record<AgentFolderKind, string>> = {
  support: SUPPORT_FOLDER,
  kol: KOL_FOLDER,
  b2b: BTOBAGENTS_FOLDER,
}

export function isAgentFolderKind(kind: MessageFolderKind | MessageRoute): kind is AgentFolderKind {
  return kind === 'support' || kind === 'kol' || kind === 'b2b'
}

/**
 * 在一份文件夹清单里认一个名字（不分大小写）：逐字相同的优先，其次第一个大小写变体，
 * 都没有回 `undefined`。归档文件夹（48 §4 L3 #5）与岗位文件夹共用这一条。
 */
export function matchFolderName(wanted: string, known: readonly string[]): string | undefined {
  if (known.includes(wanted)) return wanted
  const low = wanted.toLowerCase()
  return known.find((p) => p.toLowerCase() === low)
}

/** 同上，但都没有时回 `wanted` 本身（调用方拿去新建）。 */
export function resolveFolderName(wanted: string, known: readonly string[]): string {
  return matchFolderName(wanted, known) ?? wanted
}

/** 这只邮箱上某个岗位文件夹该用哪个真名（见文件头三条）。 */
export function resolveAgentFolder(kind: AgentFolderKind, known: readonly string[]): string {
  return resolveFolderName(AGENT_FOLDERS[kind], known)
}

/**
 * 服务器上这个岗位文件夹的**全部**大小写变体（规范名排第一）。
 * 同步要把它们都扫一遍：信在哪只里，就在消息页上哪只里看得见。
 */
export function agentFolderVariants(kind: AgentFolderKind, known: readonly string[]): string[] {
  const canonical = AGENT_FOLDERS[kind]
  const low = canonical.toLowerCase()
  const hits = known.filter((p) => p.toLowerCase() === low)
  return hits.sort((a, b) => (a === canonical ? -1 : b === canonical ? 1 : 0))
}
