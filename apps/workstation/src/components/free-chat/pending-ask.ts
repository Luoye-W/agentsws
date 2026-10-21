/**
 * WP437（Luoye 10-21）：首页简易对话框发出去的那一句，交给「我的助理」那条对话接着问。
 *
 * 首页只负责收下这句话（和附上的资料），跳到 `/assistant`；助理页一拿到对话就把它发出去——
 * 问答、派活还是助理原来那一套（答了就在对话里，交给某个岗位就「已交给 X」）。
 * 只在内存里、只留一句、取一次就没了（刷新 / 换页不会重发）。
 */
import type { FreeChatFile } from '@/lib/free-chat'

export interface PendingAsk {
  text: string
  files: FreeChatFile[]
}

let pending: PendingAsk | undefined

export function setPendingAsk(ask: PendingAsk): void {
  pending = ask
}

/** 取走（取一次就没了）。 */
export function takePendingAsk(): PendingAsk | undefined {
  const out = pending
  pending = undefined
  return out
}

/** 还有一句等着发吗（不取走）。 */
export function hasPendingAsk(): boolean {
  return pending !== undefined
}
