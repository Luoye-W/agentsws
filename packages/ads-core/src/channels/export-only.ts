/**
 * WP447（docs/109 §6.2）：六个新平台的适配器——**第一期只读、不连接口**。
 *
 * 拿数走两条路：用户把平台后台导出的报表拖进对话（本单），或插件在用户自己登录的后台点官方「导出」
 * （109F，私有插件仓）。所以这里五个口子一律回 `not_implemented`，那句人话指向「导出报表给我」，
 * 不是「连接失败」——也不是「还在申请」：这一期压根不打平台接口。
 *
 * `applyChange` 也一样回 `not_implemented`：这六条职责 yml 里**一条写动作都没有**（连止损暂停都没有），
 * 走不到这里；写在这里是第二道——万一谁绕过职责直接调过来，也只会得到一句「这一期只读」。
 */

import type { AdsPlatform } from '@agentsws/contracts'
import { adsPlatformSpec } from '@agentsws/contracts'
import type { AdsChangeRequest, AdsChannelAdapter, AdsError, AdsTransport } from './types.js'

/** 读的那几个口子回的那句话。 */
export function exportOnlyReadPlan(label: string): string {
  return `${label}这一期不连接口：在它后台点「导出」，把报表拖进对话，就能看数和体检`
}

/** 写的那一个口子回的那句话。 */
export function exportOnlyWritePlan(label: string): string {
  return `${label}这一期只读，改广告还不做——要改请在它后台自己改`
}

/** 一条只读平台的适配器（不认识的平台照样建，名字退回平台 id）。 */
export function createExportOnlyAdapter(
  platform: AdsPlatform,
  _transport: AdsTransport,
): AdsChannelAdapter {
  const label = adsPlatformSpec(platform)?.zh ?? platform
  // 不用 `notImplemented`：那句话说的是「提案、审批、额度照常」，这六条根本没有写动作
  const no = (message: string): Promise<AdsError> =>
    Promise.resolve({ ok: false, reason: 'not_implemented', message })
  const read = (): Promise<AdsError> => no(exportOnlyReadPlan(label))
  return {
    platform,
    implemented: false,
    accounts: () => read(),
    campaigns: () => read(),
    adSets: () => read(),
    insights: () => read(),
    pixels: () => read(),
    applyChange: (_input: AdsChangeRequest) => no(exportOnlyWritePlan(label)),
  }
}
