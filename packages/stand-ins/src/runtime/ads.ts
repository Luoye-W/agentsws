/**
 * WP316（docs/101 §5.1② ③）：**Run 里的改广告工具**（Google / Meta 两条投放职责）。
 *
 * 两个名字、给模型看的描述、回来的数据形状。真正干活在服务端（`apps/server/src/ads-tools.ts`，
 * 落到 `AdsPort` 上——与 `/v1/ads/changes`、`/v1/ads/ledger` 同一份装配，不另开一本账）。
 *
 * 纪律：
 * 1. **只出卡**：提一批改动 = 出上传表卡或逐条的小改动卡，人批了插件才去用户自己的后台里做；
 * 2. **只给 Google / Meta 两条投放职责**（插件第一期只接这两家后台），执行器里再判一次职责；
 * 3. 插件没配对 / 没连这家后台：卡照出，回执里带 `needs_connection: 'extension'`——运行就地出连接卡（WP324）。
 */
import type { ToolDef } from '@agentsws/contracts'

export const ADS_PROPOSE_TOOL = 'propose_ad_changes'
export const ADS_LEDGER_TOOL = 'list_ad_changes'

/** 两个工具（排好序：`tools.allow` 要字节稳定）。 */
export const ADS_TOOL_NAMES: readonly string[] = [ADS_LEDGER_TOOL, ADS_PROPOSE_TOOL].sort()

/** 插件第一期只接 Google / Meta 两家后台。 */
export const isAdsWiredRole = (role_id: string): boolean =>
  role_id === 'ads.google' || role_id === 'ads.meta'

export const ADS_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: ADS_PROPOSE_TOOL,
    description:
      '提一批广告改动（**只出卡，不直接改**）。只写要改什么：新建广告系列 / 广告组 / 广告 / 关键词、改预算、暂停或启用；' +
      '表由工坊按两家后台的官方格式生成，新建的一律先暂停。有新建或一次改 3 条以上 → 一张上传表卡；1–2 条暂停 / 改预算 → 逐条出卡。' +
      '卡批了，浏览器插件在用户自己的后台里提交，平台预览后人再确认一次。回来的 problems 是本地检查没过的地方（改好再提）；' +
      '回来带 needs_connection 说明插件还没连这家后台。',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: '广告库里的账户 id（列账户那一步拿到的）' },
        ops: {
          type: 'array',
          description:
            '改动意图，一条一个对象。kind 取 create_campaign / create_ad_group / create_ad / add_keyword / set_budget / set_status；' +
            'set_budget 写 {kind, level: campaign|ad_group, ref: {campaign, campaign_id}, before, after}；' +
            'set_status 写 {kind, level, ref, status: paused|enabled}；新建写名字与上级名字（Google 关键词写 text 与 match）。编号照导出表原样抄，查不到就别编。',
          items: { type: 'object', description: '一条改动意图' },
        },
        reason: { type: 'string', description: '为什么改（一句，上卡面）' },
      },
      required: ['account_id', 'ops'],
    },
  },
  {
    name: ADS_LEDGER_TOOL,
    description:
      '列最近的广告改动（广告变更账本）：每条批过的改动走到哪了（排队 / 在做 / 等人确认 / 做完 / 退回 / 交给人 / 作废）、' +
      '平台预览报的原话、读回核对对没对上、有没有截到图、能不能撤销。被退回的照平台原话改了再提。只读。',
    input_schema: { type: 'object', properties: {} },
  },
]

export const ADS_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  ADS_TOOL_DEFS.map((d) => [d.name, d]),
)
