import type { EventId, Iso8601, ObjectRef, RunId, WorkspaceId } from './common.js'

/** 事件日志信封（21 §1）。append-only；写永远最新版；payload 已脱敏，秘密从不进。 */
export interface EventEnvelope<T extends string = string, P = unknown> {
  id: EventId
  schema_version: number
  workspace_id: WorkspaceId
  type: T
  at: Iso8601
  actor: { kind: 'person' | 'agent' | 'system' | 'sentinel'; id: string; run_id?: RunId }
  subject?: ObjectRef
  correlation: {
    trace_id: string
    run_id?: RunId
    work_item_id?: string
    change_id?: string
    execution_id?: string
  }
  payload: P
  payload_encrypted?: { key_id: string; blob: string }
  prev_hash?: string
}

/** 已定义的事件类型名（14 §10、15 §7、17 §2、19 §6、24 §5、25 §5、22 §3）。新增事件加在这里。 */
export type KnownEventType =
  // approval (14)
  | 'approval.created'
  | 'approval.blocked'
  | 'approval.routed'
  | 'approval.delivered'
  | 'approval.claimed'
  | 'approval.escalated'
  /** WP275：① ② 没有审批流，卡没人管到点只提醒本人（不升级给别人）。 */
  | 'approval.reminded'
  | 'approval.decided'
  | 'approval.auto_approved'
  | 'approval.sampled'
  | 'approval.applying'
  | 'approval.applied'
  | 'approval.apply_failed'
  | 'approval.expired'
  | 'approval.withdrawn'
  | 'approval.superseded'
  /** WP414：一张卡的「不要 / 稍后」带动了同类卡一并处理（账本：谁的哪个决定带动了哪几张）。 */
  | 'approval.followed'
  /** WP414：跟着处理的卡被撤回、放回待处理。 */
  | 'approval.reopened'
  /** WP414：决定之后补了一句理由（「不要」理由可选）。 */
  | 'approval.reason_added'
  // changes (15)
  | 'change.staged'
  | 'change.blocked'
  | 'change.approved'
  | 'change.applying'
  | 'change.applied'
  | 'change.unknown'
  | 'change.failed'
  | 'change.expired'
  | 'change.withdrawn'
  | 'change.superseded'
  | 'change.reversed'
  | 'guardrail.hit'
  // run (17)
  | 'run.started'
  | 'context.injected'
  | 'prompt.assembled'
  | 'text.delta'
  | 'tool.call'
  | 'tool.result'
  /**
   * WP53：真环境记录源真的跑了一次工具（17 §2 的 `tool.result` 之外多这一条）。
   * payload 只有 `tool` / `status` / `duration_ms` / `provenance` 条数 / 失败原因码，
   * **订单内容一个字节都不进**（21 §1）。
   */
  | 'tool.executed'
  /** WP53：31 §3.3 的联系人台账里多认识了一个人；payload 只有不可逆的 id 与来路。 */
  | 'contact.noted'
  | 'proposal.created'
  | 'ui'
  | 'ui.partial'
  | 'progress'
  | 'budget.warning'
  | 'budget.exhausted'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  // model (22)
  | 'model.usage'
  | 'model.provider_down'
  | 'model.budget_frozen'
  /**
   * WP425：这一轮从自己的 AI 切到了工坊积分（额度用完 / 连不上 / key 失效）。payload 只有
   * 从哪个模型、到哪个模型、原因码与给人看的那一句——没有 key、没有请求正文。
   */
  | 'model.source_switched'
  /**
   * WP430（决策 1289）：登录类的 AI 来源（ChatGPT 订阅、DeepSeek 账号）登录失效 / 过期，要人重新登录。
   * 这一轮已经按 AI 来源顺序切到下一个接着做，不停下、不出卡；站内通知（WP429）接这条提醒人去重登。
   * payload 只有来源 id 与来源名（`{ provider, label }`），没有账号名、没有令牌。同一来源在重新能用之前只发一次。
   */
  | 'model_source.relogin_needed'
  /**
   * WP436（决策 1316）：用户自带的 API key 被拒（401 / 403、key 失效 / 被吊销），要人去换一把。
   * 有别的来源时这一轮照样按 AI 来源顺序接着做；站内通知（WP429）接这条提醒人去「设置 → 模型」换 key。
   * payload 只有来源 id 与来源名（`{ provider, label }`），没有 key。同一来源在重新能用之前只发一次。
   */
  | 'model_source.key_rejected'
  /**
   * WP150：「用我的 DeepSeek 账号登录」那一条模型来源被摘掉了——手动登出（`reason: 'signed_out'`）
   * 或平台说登录失效（`reason: 'expired'`）。payload 只有 provider id 与原因，没有账号名、没有令牌。
   */
  | 'model.account_signed_out'
  /**
   * WP179：一次网页搜索 / 一次抓网页的**审计**（官方 `web_search` / `web_fetch`）。
   * payload 只有查询串或网址、结果条数 / 状态码、凭据种类与成败——**网页正文一个字都不进**。
   */
  | 'web.searched'
  | 'web.fetched'
  /**
   * WP180：官方插件装 / 升级 / 卸载**做完了**（卡批了之后）。payload 只有动作、包名、版本、卡的 id。
   */
  | 'official_plugin.changed'
  /**
   * WP180：一次官方插件变动**被拒**——不在审过的清单里、版本不对、或者做完会改到 profile patch
   * （那一下已经原样恢复）。payload 只有动作、包名、原因码与一句人话。
   */
  | 'official_plugin.rejected'
  /**
   * WP180：一次运行中的配置保存**被拒**——它想写锁定表里的行（B / C 类，例如把会话日志上报打开）。
   * payload 只有行 id、原因码与想改的字段名（**不带值**）。
   */
  | 'profile.config_rejected'
  /**
   * WP219：内容更新通道。`checked`（查了一次清单：序号、几条新的）/ `applied`（一个品牌换上新版：
   * 条目、版本、自动还是人点的）/ `rolled_back`（退回上一版）/ `rejected`（整包拒收：原因码与一句人话）/
   * `conflict`（新版与你的改动冲突、出了卡）/ `resolved`（冲突选了用新版或保留我的）。
   * payload 只有条目 id、版本、原因码——**技能正文不进事件**。
   */
  | 'content_update.checked'
  | 'content_update.applied'
  | 'content_update.rolled_back'
  | 'content_update.rejected'
  | 'content_update.conflict'
  | 'content_update.resolved'
  /**
   * WP406（私有 docs/107）：官方岗位更新。`digest_carded`（一个岗位出 / 并了一张本周更新卡：岗位、几项、急不急）/
   * `digest_applied`（应用了一批：岗位、条目 id、自动还是人点的）/ `digest_skipped`（这次跳过）/
   * `batch_rolled_back`（整批 / 单项退回）/ `subscription_checked`（问了一次订阅：状态码）。
   * payload 只有岗位、条目 id、版本、状态——**内容正文不进事件**。
   */
  | 'content_update.digest_carded'
  | 'content_update.digest_applied'
  | 'content_update.digest_skipped'
  | 'content_update.batch_rolled_back'
  | 'content_update.subscription_checked'
  /**
   * WP181：模型调了官方「自动化任务」的一个工具（建 / 查 / 改 / 删提醒）。payload 只有工具名、这次运行、
   * 任务 id、结果（建了 / 等批 / 改了 / 删了 / 被拒）与原因码——**提醒正文不进**。
   */
  | 'automation.requested'
  /** WP181：到点了但这个岗位今天的自动运行次数到了上限，这一次没跑。payload：任务 id、上限、今天第几次。 */
  | 'automation.capped'
  // memory（54 §3 / WP71 / WP320）
  /**
   * WP320：一层记忆里新增 / 改动 / 合并（AI 把新说法并进它以前记的那条）/ 删掉一条。
   * actor：人写的是 `person`，AI 随工作记的是 `agent`（id 是替谁记的那个人，`run_id` 是那次运行）。
   * payload：`entry_id` / `tier` / `scope_id` / `skill` / `by` / `written_by` / `reason?` / `run_id?` /
   * `matter_id?`——**不带正文**。`memory.merged` 另有一种岗位合并时的整层搬家（payload 带 `from` / `into`）。
   */
  | 'memory.added'
  | 'memory.updated'
  | 'memory.merged'
  | 'memory.removed'
  /** WP234：岗位拆出时整层复制一份（payload：`from` / `scope_id` / `copied`）。 */
  | 'memory.copied'
  /**
   * WP352：助理一条长对话。`assistant.context` 每一轮拼进了多少（当前段原话 / 段内小结 / 最近几段小结 /
   * 记忆的条数与 token 估算、切没切段）；`assistant.topic` 一段收起出了小结、或段内压缩了一次。**不带正文**。
   */
  | 'assistant.context'
  | 'assistant.topic'
  // knowledge (19)
  | 'knowledge.card.proposed'
  | 'knowledge.card.activated'
  | 'knowledge.card.retired'
  /** WP506（决策 1789 B）：人在知识库里停用 / 启用了一条（检索排除 / 回来）。 */
  | 'knowledge.card.disabled'
  | 'knowledge.card.enabled'
  | 'knowledge.card.conflict'
  | 'knowledge.card.recalled'
  /**
   * 47 J2 / J3：检索命中了一条**历史案例**（带"当时"时间戳的旧状态），
   * 而这次运行问的是"现在怎么样"。Agent 以操作层为准回答，同时把这条知识标出来
   * ——它该更新了。24 的学习回路吃这条对应的 `knowledge_update` 卡。
   */
  | 'knowledge.card.stale'
  | 'knowledge.card.cited'
  | 'knowledge.gap.opened'
  | 'knowledge.gap.answered'
  /**
   * WP99（19 §1.3）：知识库里多了 / 少了一个**导入源**。
   *
   * 「上传一份文件」的溯源就落在这两条上：payload 带**谁传的、什么时候、
   * 内容的 sha256、多大、什么类型**——`filename` 只带洗过的那一份，
   * **正文一个字节都不进事件日志**（21 §2 / 13 §4：内容不进日志）。
   */
  | 'knowledge.source.added'
  | 'knowledge.source.removed'
  // WP56（48 §4 #6 知识溯源链）：源页 / 文档内容变了之后的那条链。
  // `knowledge.card.stale` 复用上面那条（47 J2 与源页复核是同一个意思：这条别当"现在"用）。
  /** 复核完了（或受管辖数值压根没变）→ 这张卡回鲜，`last_verified_at` 往前走。 */
  | 'knowledge.card.refreshed'
  /** 开了一张复核卡（`knowledge_update` 的 recheck 形态，三选一）。 */
  | 'knowledge.recheck.opened'
  /** 有人答了那张复核卡：确认没变 / 按新值更新 / 忽略。 */
  | 'knowledge.recheck.resolved'
  // simulation (26)：RunRequest 落日志，回放据此重组 prompt
  | 'simulation.run_request'
  | 'simulation.sampling_review'
  | 'simulation.reconciled'
  | 'simulation.process_restarted'
  // delivery / notification (18)
  | 'notification.sent'
  // connect (08/18)：payload 只带 token 指纹，永不带原文
  | 'connect.token_issued'
  | 'connect.tokens_revoked'
  | 'connect.executed'
  | 'connect.execute_failed'
  | 'connect.proxy_denied'
  | 'connect.connection_started'
  | 'connect.connection_established'
  | 'connect.connection_transferred'
  // WP20：表单直填只记字段名；试连只记 ok / reason
  | 'connect.form_submitted'
  | 'connect.connection_removed'
  | 'connect.connection_tested'
  // WP44：Shopify 深度接入——老 shpat 连接标 legacy；主题 CLI 只记命令名与退出码；GraphQL 校验结果
  | 'connect.legacy_connection_detected'
  | 'shopify.theme_command'
  | 'shopify.theme_pushed'
  | 'shopify.theme_published'
  | 'shopify.theme_dev_started'
  | 'shopify.theme_cli'
  | 'shopify.graphql_rejected'
  | 'shopify.graphql_unvalidated'
  | 'shopify.devmcp_started'
  | 'shopify.devmcp_unavailable'
  // WP46：活数据源——只记条数 / 页数 / 耗时 / 失败原因码，订单原文不进事件
  | 'data.refreshed'
  | 'data.refresh_failed'
  // WP47：范围模型（44）——品牌（范围组）与产品线的增删改；payload 只有 id / 名字 / 成员条数
  | 'range_group.created'
  | 'range_group.updated'
  | 'range_group.deleted'
  | 'product_line.created'
  | 'product_line.updated'
  | 'product_line.deleted'
  /** 44 G5：品牌组成员变了，挂了它的岗位范围自动跟着变——**变更必须留痕**（40 §1 的底线）。 */
  | 'assignment.range_expanded'
  /**
   * WP138（78 §1 #1）：向导建了哪几条分配、挂的是什么范围（以后分「向导建的」与「手动分配的」靠它）；
   * 以及启动时那一次补挂——老版本没连店就挂空的职责，补上向导今天会挂的那一份。
   * payload 只有分配 id 与范围（`{kind, id}`），没有人名。
   */
  | 'onboarding.applied'
  | 'assignment.range_backfilled'
  // WP50：个人用 → 公司用（45）。合并与别名都留痕；payload 只有 id / 名字 / 条数，不含成员内容
  /** 45 H3：两条品牌合成一条（公司那份取并集，个人那份 `superseded_by`）。 */
  | 'range_group.merged'
  /** 45 H3：两条产品线合成一条。 */
  | 'product_line.merged'
  /**
   * 45 H3：一条岗位范围因为别名被改指到公司那份，或退出公司时别名断开恢复个人那份。
   * payload 带 `from` / `to` / `direction`（`to_company` | `back_to_personal`）。
   */
  | 'range.alias_resolved'
  // WP24：问 AI 只记哈希；急停变更
  | 'ask.answered'
  | 'halt.changed'
  /**
   * WP215：全进程「后台同时最多跑几件」改了（payload：`from` / `to`）。品牌急停照旧记
   * `halt.changed`，只是记在那个品牌名下、payload 多一位 `brand`。
   */
  | 'background.concurrency_changed'
  // WP28：成员与邀请（token 只记指纹）
  | 'invitation.created'
  | 'invitation.accepted'
  | 'membership.removed'
  /*
   * WP51（46）：首次设置与同事发现。
   *
   * 三条纪律写在 payload 里：`workspace.profile_set` 只记**归一化后的哈希**与有没有域名，
   * 全称不进日志；`discovery.peer_seen` 只有对方的 peer_id 与主机端口，没有成员名单；
   * 邀请码同样只记指纹（`code_sha256` 的前若干位），明文只出现在 owner 手里那一次。
   */
  | 'workspace.profile_set'
  | 'discovery.enabled'
  | 'discovery.disabled'
  | 'discovery.peer_seen'
  | 'invite.created'
  | 'invite.redeemed'
  | 'membership.requested'
  | 'membership.approved'
  | 'membership.rejected'
  /*
   * WP65（52 O1）：品牌是顶层——公司 = 组织，品牌 = 工作区。
   *
   * `organization.created` 的 payload 与 `workspace.profile_set` 同一条纪律：
   * 只记归一化后的 `company_key` 与有没有域名，公司全称不进日志。
   * `brand.created` 只记新品牌的 `workspace_id` 与它挂在哪个组织下——品牌名是
   * 用户起的名字，与公司名同级，一样不进日志。
   *
   * 切品牌（`brand.switched`）**不在这里**：它是客户端的一次导航，不改任何数据，
   * 不该占内核日志的一行（52 §4）。
   */
  | 'organization.created'
  | 'brand.created'
  /*
   * WP271（docs/95 §3.2）：组织的用法（① 个人 / ② 同事互联 / ③ 公司集体）改了。
   * 启动时按决策 232 推出来写上也记一条（`inferred: true`）。只记模式，不记任何名字。
   */
  | 'organization.mode_changed'
  // schedule / workflow (25 §5, WP27)
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.fired'
  | 'schedule.failed'
  | 'schedule.misfired'
  | 'schedule.paused'
  | 'schedule.resumed'
  | 'schedule.deleted'
  | 'workflow.started'
  | 'workflow.step.completed'
  | 'workflow.step.failed'
  | 'workflow.waiting'
  | 'workflow.failed'
  | 'workflow.compensated'
  | 'workflow.done'
  | 'workflow.cancelled'
  // WP31：本机秘密库密钥轮换（payload 只有时间与条数）
  | 'secrets.key_rotated'
  // WP42：价目表刷新（只记条数与来源）
  | 'pricing.refreshed'
  /*
   * WP58（49 M1）：本地工作区与云账号的关联。**本地事件**，不是云侧的。
   *
   * payload 只有邮箱**域名**与云侧组织 id（见 `CloudAccountLinkedPayload`）：
   * 令牌明文与哈希、邮箱本地部分一个字节都不进（21 §1）。
   */
  | 'cloud.account_linked'
  | 'cloud.account_unlinked'
  /**
   * WP233：本机负责人的登录邮箱从占位改成了云账号邮箱（`PersonEmailChangedPayload`）。
   * 同上一条纪律：payload 只有两头的**域名**与 person_id。
   */
  | 'person.email_changed'
  // privacy (21)
  | 'privacy.erased'
  // meetings (37 §4)：payload 只有摘要与条数，转写与音频永不进日志
  | 'meeting.record.ingested'
  | 'meeting.record.blocked'
  | 'meeting.record.transcribed'
  | 'meeting.record.processed'
  | 'meeting.record.failed'
  // 工作模型 (37 §2)：摘要级，正文永不进日志（正文在事项时间线里）
  | 'todo.created'
  | 'todo.updated'
  | 'todo.done'
  | 'todo.dropped'
  | 'matter.opened'
  | 'matter.closed'
  | 'matter.message'
  /**
   * WP69（54 §2）：岗位内路由判完了。payload 只有 `position_id` / `picked` /
   * 候选的 `role_id` 与分数 / `ambiguous`——**判据词与原话不进日志**（21 §1），
   * 那句话在事项时间线上。
   */
  | 'matter.routed'
  /** WP69：人手动换了职责（`POST /v1/matters/:id/reroute`）；payload 只有前后两个 role_id。 */
  | 'matter.rerouted'
  /**
   * WP207：事项归档 / 取消归档。payload 只有 `by`（`auto` / `user` / `ai_suggested` /
   * `activity`）、空闲天数与条数——标题与正文不进日志。
   */
  | 'work.archived'
  | 'work.unarchived'
  /**
   * WP276（docs/95 §4）：交给对方。payload 只有对象种类 / id / 谁交给谁 / 结果——
   * 标题、留言、不接的理由都不进日志（在事项时间线与卡上）。
   */
  | 'handoff.offered'
  | 'handoff.accepted'
  | 'handoff.declined'
  | 'handoff.returned'
  | 'handoff.withdrawn'
  /** WP276：② 里有人自己退出 / 被请离开（payload 只有 person_id 与退回了几件事）。 */
  | 'member.left'
  // 恢复先对账（WP34 B）：payload 只有条数与结论
  | 'reconcile.started'
  | 'reconcile.finished'
  // inbound / delivery (18)
  | 'inbound.received'
  | 'inbound.deduped'
  | 'inbound.dead_letter'
  | 'delivery.sent'
  | 'delivery.failed'
  // WP57（48 §4 L3 #11）：网站在线聊天。入站仍用 `inbound.*`（同一条管线），
  // 这三条记的是聊天独有的那几件事：一轮判了什么、人接管了、求助超时怎么处理的
  | 'chat.turn_planned'
  | 'chat.takeover_changed'
  | 'chat.assist_timeout'
  // WP417（决策 1232）：在线客服缺省要人批——这一句起草好了、先出卡等人批（payload：原因、卡 id）
  | 'chat.reply_held'
  // WP417（自查 C15）：聊天里没等到人 → 出了一张跟进邮件卡（payload：卡 id；邮箱不进日志）
  | 'chat.email_follow_up'
  // WP428（决策 1246 改）：按置信度直接答了一句（payload：分数、档位、出处 id）；人说「这句不该直接答」（payload：消息 id）
  | 'chat.auto_answered'
  | 'chat.auto_answer_flagged'
  // WP428（决策 1244 改）：够条件 → 建议开全自动（payload：哪一类、哪条岗位、卡 id）；开了 / 关了（关的原因：人关 / 出事）
  | 'autopilot.suggested'
  | 'autopilot.turned_on'
  | 'autopilot.turned_off'
  // WP57：商家在聊天里「教 AI」之后沉淀下来的知识候选（承诺类永不自动发布，19）
  | 'knowledge.candidate_created'
  // WP54（48 v2 L1）：职责改名 / 合并之后，已有分配在启动时迁到新 id。
  // payload 只有分配 id、人、旧 id、新 id、迁过去的职责版本——改名也是一次变更，必须留痕。
  | 'assignment.role_migrated'
  // WP295（docs/95 §5）：出厂默认等级改过的动作，还停在旧默认值、没人动过的分配启动时迁到新默认值。
  // payload：分配 id、人、职责 id、动作 id、旧等级、新等级。
  | 'assignment.automation_default_migrated'
  // WP462：职责升了大版本，分配跟着接上。payload：分配 id、人、职责 id、怎么接的（就地重确认 / 拆分补发）、
  // 旧版本、新版本、自动还是人点的、登记表里那个词、补发那条接的是哪条原分配。
  | 'assignment.role_major_upgraded'
  // WP55（48 §4 L3 #2–#5）：客服安全边界四件套。payload 一律只有结论与计数，
  // 正文、relay 地址、凭据永不进日志。
  /** Amazon 24h 响应线的三档（提醒 / 升级 / 闭账）。 */
  | 'support.amazon_sla'
  /**
   * WP440（docs/108 M9）：邮件客服按把握直接回了一封（payload：卡 id、分数、档位、出处 id）；
   * 没直接回、照旧出卡（payload：原因类别、分数）；人说「这封不该直接回」（payload：卡 id）。正文不进日志。
   */
  | 'support.email_auto_replied'
  | 'support.email_auto_reply_held'
  | 'support.email_auto_reply_flagged'
  /** 三道门的结论（只记门名与 pass / fail / gate_error，不记被扫的文本）。 */
  | 'guardrail.gate_decided'
  /** 出站 outbox 的状态迁移（prepared → sending → accepted → confirmed / …）。 */
  | 'outbound.state_changed'
  /** `sent_unknown` 的对账结论（找到证据 / 没找到 / 退避次数耗尽）。 */
  | 'outbound.reconciled'
  /** 邮箱加固：毒消息隔离、扫描租约被别人占着、归档文件夹动不了。 */
  | 'inbound.folder_fault'
  /**
   * WP163：判成客服的信在邮箱里的一个动作（标已读 / 挪进 `KefuAgents` / 跳过 / 失败）。
   * payload 只有原因码、文件夹与 uid，地址遮掉，没有正文。
   */
  | 'inbound.mailbox_action'
  /** 死信被人重投回队列（WP210 起也可能是系统按退避自动投的，payload 带 `auto: true`）。 */
  | 'inbound.requeued'
  /**
   * WP210：一条死信判定为彻底投不进（自动重投用完 / 路由类失败），不再自动重投。
   * payload 只有死信 id、原因、轮数、是不是客户来信——没有正文。
   */
  | 'inbound.dead_letter_gave_up'
  /** WP345：浏览器插件因为工坊换了新版而自己重载，重载后报上来的新版本（payload：from / to / 扩展 id）。 */
  | 'extension.updated'
  /** WP345：插件重载过、还是没换成工坊文件夹里那一版（多半是从别的文件夹加载的；payload：running / wanted）。 */
  | 'extension.update_failed'
  /**
   * WP360（决策 947）：需要插件的岗位上「装插件」那张引导卡，人点了「稍后」——当天（本地日）收起。
   * payload：发起人那条分配、哪几条职责要插件（只有 id，没有任何内容）。
   */
  | 'extension.onboarding_snoozed'
  /**
   * WP360：人第一次在需要插件的岗位上说话、插件还没配上——AI 先说一句、把装插件那张卡带进这件事。
   * 同一条分配只一次。payload：分配、事项 id、卡 id。
   */
  | 'extension.onboarding_prompted'

export interface EventLog {
  append<T extends string, P>(
    e: Omit<EventEnvelope<T, P>, 'id' | 'at'>,
  ): Promise<EventEnvelope<T, P>>
  read(filter: {
    workspace_id: WorkspaceId
    /** 续传游标：ulid 严格递增，`id > since`。 */
    since?: EventId
    /** 时间下界（ISO-8601，闭区间，`at >= since_at`）；与 `since` 可同时给，取交集。 */
    since_at?: Iso8601
    /** 时间上界（ISO-8601，闭区间，`at <= until_at`）。 */
    until_at?: Iso8601
    types?: string[]
    run_id?: RunId
    limit?: number
  }): AsyncIterable<EventEnvelope>
  /** 21 §1：回放一次运行，重组模型输入（17 用例 1） */
  replayRun(run_id: RunId): AsyncIterable<EventEnvelope>
}
