import type {
  AssignmentId,
  DataDomain,
  Iso8601,
  ObjectRef,
  PersonId,
  RangeRef,
  RoleId,
  RunId,
  Sensitivity,
  WorkspaceId,
} from './common.js'
import { GROSS_MARGIN_SUBJECT_TYPE, GROSS_MARGIN_VISIBLE_ROLES } from './economics.js'

/**
 * 19 §1 事实卡的层。
 *
 * WP52（47 J2）加了第四层 `historical_case`：**知识层只存文字与判断，不存状态**。
 * 带订单号 / 金额 / 库存数 / 履约状态这类"状态词"的句子进 Wiki 时降到这一层，
 * 打上"当时"的时间戳（`as_of`），从此它是**历史案例**不是事实——回答时可以参考
 * "上次这种情况我们怎么办的"，但不能拿它当"现在是什么样"。
 *
 * **只加不删**：原来那三层的含义一个字没动。
 */
export type KnowledgeLayer = 'fact' | 'phrasing' | 'policy' | 'historical_case'

/**
 * WP56（48 §3 L2）：**售前 / 售后不是两套模式，是每条知识的适用范围**。
 *
 * 一个工作区只有一个知识库；同一个问题在售前与售后要答得不一样时，不复制一份
 * 知识库出来，而是把两条知识各自标上适用范围。缺省 `both`——存量卡一条不用改。
 */
export type KnowledgeStage = 'both' | 'presales' | 'postsales'

/**
 * WP56（48 §4 #6）：这条知识现在还能不能当"现在的口径"用。
 *
 * - `fresh`：源没变过，或者变了但受管辖数值没变，或者人复核过了；
 * - `stale`：源页 / 文档改了且**受管辖数值真的变了**，还没人复核。
 *   **仍然进检索**——只是在溯源分层里排到最后，装不下预算时最先被挤出去；
 * - `quarantined`：唯一真正从检索里排除的状态，**只能由人显式产生**。
 *
 * 缺省（字段为空）等价于 `fresh`：不写这一格的实现与 WP56 之前逐字段一致。
 */
export type KnowledgeVerificationState = 'fresh' | 'stale' | 'quarantined'

/**
 * WP56（48 §4 #6）：**溯源等级是读取时派生值，不占一格**。
 *
 * - `tracked`：出处指向一个登记过的 `KnowledgeSource`（内容变了追得到）；
 * - `cited`：只有一个 URL / 文件路径（有出处，但逐页追不了）；
 * - `unverified`：出处不明。
 *
 * 铁律：`unverified` **不阻断使用**，它只影响排序与 prompt 里的措辞。
 */
export type KnowledgeProvenanceGrade = 'tracked' | 'cited' | 'unverified'

export interface Provenance {
  source: 'document' | 'meeting' | 'email' | 'web' | 'human' | 'agent_inference'
  ref: string
  locator?: string
  quote?: string
  at: Iso8601
}
export interface FactCard {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  layer: KnowledgeLayer
  domain: DataDomain | 'company'
  scope: RangeRef[]
  sensitivity: Sensitivity
  subject: { type: string; id?: string; key: string }
  statement: string
  structured?: Record<string, unknown>
  provenance: Provenance[]
  confidence: {
    value: number
    state: 'unverified' | 'plausible' | 'probable' | 'verified' | 'refuted'
  }
  conflicts?: { with: string; note: string }[]
  valid: { from?: Iso8601; until?: Iso8601 }
  /**
   * 47 J2：这句话描述的是**什么时候**的状态。
   *
   * 只有 `historical_case` 层有——它就是那个"当时"。`valid.from` 说的是"这条从
   * 什么时候开始生效"（政策的启用日），两回事：一条 2026-09 写下的退款记录，
   * `as_of` 是 2026-09，而它作为一条政策从来没有"生效"过。
   */
  as_of?: Iso8601
  /**
   * 47 J2：进入管道把它从哪一层降下来的。
   *
   * 留着是为了**能改回去**：正则会误伤（"我们承诺 30 天内退款"里也有数字），
   * 人在界面上点一下就能还原成原来那层，不用猜它本来是什么。
   */
  downgraded_from?: KnowledgeLayer
  /**
   * WP56（48 §3 L2）：这条知识管售前还是售后。缺省 `both`。
   *
   * 检索时只排除**只属于另一头**的条目：问的是售后，`presales` 的不进候选；
   * `both` 两头都进。
   */
  stage?: KnowledgeStage
  /**
   * WP56（48 §4 #6）：正文里那几个**受管辖数值**的类型化快照。
   *
   * 键是 `<类别>:<归一化后的值>`（`duration:day:30` / `money:USD:15` /
   * `responsibility:payer_customer`…），值是原始出现形态。源页改了先比它——
   * 改的是排版、措辞、SEO 文案就当没改；改的是退款天数、保修月数、运费承担、
   * 赔偿比例、币种，才算实质变更。
   *
   * **LLM 不参与这个判断**：抽取与比对都是纯函数（`packages/knowledge` 的
   * `fact-fingerprint.ts`），同输入同输出。
   */
  fact_fingerprint?: Record<string, string | number>
  /** WP56：见 `KnowledgeVerificationState`。缺省等价于 `fresh`。 */
  verification_state?: KnowledgeVerificationState
  /** WP56：这条卡是从源的**哪一版**派生出来的（源内容的 sha256 前 16 位）。 */
  source_content_hash?: string
  /** WP56：源最后一次变内容是什么时候（受管辖数值没变时也记，用来说"源动过但口径没动"）。 */
  source_changed_at?: Iso8601
  /**
   * WP56（48 §4 #9 缺口补）：外部链接。
   *
   * **没有上传、没有图床、没有富文本**——只存 URL（教程视频、帮助中心页、
   * 商品图的外链）。正文里说不清的东西贴一个链接进来，Agent 在回信里原样引用。
   */
  media?: string[]
  /**
   * WP56：最后一次有人**确认过**这条口径是什么时候。
   *
   * 为空就是"没记录"——prompt 里如实写"未记录"，**禁止拿 `created_at` 冒充**：
   * 写下来的日期不是核实过的日期。
   */
  last_verified_at?: Iso8601
  /**
   * WP506（决策 1789 B）：人在知识库里**停用**了这一条（什么时候、谁）。
   *
   * 停用不删、也不动 `status`（启用回来就是原样）：检索层直接把它排除在候选之外，
   * 回复、起草、边界判断都取不到它。只有人能停用 / 启用（AI 运行的令牌一律 403，没有工具）。
   */
  disabled_at?: Iso8601
  disabled_by?: PersonId
  usage: {
    recalled: number
    cited: number
    last_recalled_at?: Iso8601
    drafts_edited_after_cite: number
  }
  status: 'proposed' | 'active' | 'retired'
  owner: PersonId
  created_by: { kind: 'agent' | 'person'; id: string }
  created_at: Iso8601
  updated_at: Iso8601
}

export interface KnowledgeSource {
  id: string
  workspace_id: WorkspaceId
  kind: 'upload' | 'feishu_doc' | 'shopify_page' | 'website' | 'email_thread' | 'meeting'
  ref: string
  acl_inherit: boolean
  last_synced_at?: Iso8601
  chunks: number
  parser: 'anydoc' | 'html' | 'transcript'
  /**
   * WP56（48 §4 #6）：上一次同步时这个源的内容 hash（sha256 前 16 位）。
   *
   * 下一次 `sync` 拿新内容算一遍 hash：一样就什么都不做；不一样才去比事实指纹。
   * 为空 = 还没同步过，第一次同步只记 hash，不产生复核。
   */
  last_content_hash?: string
  /* ── WP99（19 §1.3「上传」）：`kind: 'upload'` 才有的几格。**只加不改** ──
   *
   * 为什么不塞进 `ref` 里：`ref` 是"到哪去拿这份东西"（`blob://<key>`），
   * 而下面这几格是"这份东西是怎么来的"。混在一起的话，光把文件名显示出来
   * 就得先解析一个 URL——而 key 是内容 hash，里面根本没有名字。
   */
  /** 给人看的原始文件名（洗过：没有路径、没有控制字符）。 */
  filename?: string
  /** 谁传的。 */
  uploaded_by?: PersonId
  /** 什么时候传的。 */
  uploaded_at?: Iso8601
  /** 原件内容的 sha256（十六进制全长）。溯源链认的就是它。 */
  content_sha256?: string
  /** 原件明文字节数。 */
  size?: number
  /**
   * 软删（21 的擦除语义）：字节已经从对象存储里删掉了，这一行留着是**墓碑**。
   *
   * 清单里不再出现它；留行是为了"这个 id 曾经存在过"仍然追得到——
   * 事件日志里 `knowledge.source.added` 与 `.removed` 两条都指着它。
   */
  deleted_at?: Iso8601
}

/** 19 §1.3 的登记入参（`id` / `chunks` / `last_synced_at` 由实现给）。 */
export interface KnowledgeSourceInput {
  kind: KnowledgeSource['kind']
  ref: string
  parser: KnowledgeSource['parser']
  acl_inherit?: boolean
}

/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：一个导入源的**原件字节**。
 *
 * 只给字节与三格元数据，**服务端不做任何转换**——官方那一侧是本机 LibreOffice
 * 转 PDF 再渲染（`dsh-office-to-pdf` → `libreoffice-kit`，平台包 259 MB，WP93 已经
 * 用 `ignoredOptionalDependencies` 挡掉了）。我们反过来：字节原样下发，Word / Excel /
 * PPT 在浏览器里用纯 JS 渲染（`components/rail/panels/office-preview-panel.tsx`）。
 *
 * 这么分的三个理由：①「转一次存起来」要为每份上传多存一份 PDF，40 §1.2 的数据边界上
 * 又多一个副本；② 转换进程是一大块 C++ 攻击面，而喂给它的正是外来文件；
 * ③ 渲染放在客户端，服务进程这一侧就只剩「读一个文件」这件看得懂的事。
 */
export interface KnowledgeSourceFile {
  bytes: Uint8Array
  /** 给人看的原始文件名（"下载原件"按钮用的就是它）。 */
  filename: string
  content_type: string
  /** 明文字节数（与 `bytes.length` 相同；单列一格是为了让调用方不必先拿到字节）。 */
  size: number
}

export type KnowledgeGapStatus = 'open' | 'answered' | 'dismissed'

/**
 * 19 §4 缺口：「Agent 答不了 → question 提议 → 有人答 → 自动变 knowledge_update」。
 *
 * WP33 时它只是网关包里的一个本地类型（19 §6 的 API 表提了 `POST /knowledge/gaps`，
 * 契约里却没有这个对象）；WP35 搬进契约——换一个知识实现照样接得上。
 */
export interface KnowledgeGap {
  id: string
  workspace_id: WorkspaceId
  question: string
  /** 关于什么（与 `FactCard.subject` 同形）。 */
  subject: { type: string; id?: string; key: string }
  domain: DataDomain | 'company'
  status: KnowledgeGapStatus
  asked_by: { kind: 'agent' | 'person'; id: string }
  run_id?: RunId
  answer?: string
  answered_by?: PersonId
  answered_at?: Iso8601
  /** 答完之后生成的那张 `knowledge_update` 审批项。 */
  approval_item_id?: string
  created_at: Iso8601
  /**
   * WP125（72 §1.C「有多少客户在等」/ §P0-3）：**正在等这条答案的人**。
   *
   * 按 `thread_id`（邮件线程）/ `session_id`（聊天会话）去重，一条线程只占一个位置。
   * 这是缺口从「一条日志」变成「一条闭环」的那一格：待补区按 `waiting.length` 排序
   * （不是更新时间），商家补完之后给每一个等待者各出一张 `pending_review` 草稿卡
   * ——**路径里零发送函数**。
   *
   * 不落第二张表（走 `knowledge_gaps` 上新加的一列 JSON）：等待者是缺口的一个属性，
   * 不是一个有自己生命周期的实体，拆出去只会多一次连表与一次不一致。
   */
  waiting?: readonly KnowledgeGapWaiter[]
}

/**
 * WP125：一个正在等这条知识的人。
 *
 * **不存正文**：这里只有"哪条线程、哪条渠道、什么语言、什么时候开始等的"。
 * 客户原话留在受控原始材料区里，缺口队列不该变成第二份对话副本。
 */
export interface KnowledgeGapWaiter {
  /** 去重键：邮件线程 id 或聊天会话 id。 */
  thread_id: string
  /** 哪条渠道（出草稿卡时按它选投递口）。 */
  channel: 'email' | 'chat'
  /** 回信 / 回话要用的语言（support-core 的 `SupportLanguage` 那一组值）。 */
  language?: string
  /** 开始等的时刻（同样人数时按"等了多久"做次级排序）。 */
  since: Iso8601
  /** 已经给客户回过的那一条预期 preset id（`compiling_details` / `checking_with_team` / `sending_guide`）。 */
  expectation?: string
}

export interface KnowledgeGapInput {
  question: string
  subject: { type: string; id?: string; key: string }
  domain?: DataDomain | 'company'
  run_id?: RunId
}

export interface KnowledgeGapAnswer {
  gap: KnowledgeGap
  /** 19 §4：答案不直接生效，先变一张审批项。 */
  approval_item_id?: string
}

export interface RetrievalActor {
  person_id: PersonId
  assignment_id: AssignmentId
  role_id: RoleId
  workspace_id: WorkspaceId
}
export interface RetrievalHit {
  fact_card_id: string
  score: number
  layer: KnowledgeLayer
  statement_redacted: string
  provenance_summary: string
  sensitivity: Sensitivity
  /** 47 J2：`historical_case` 层才有——这句话说的是**什么时候**的状态。 */
  as_of?: Iso8601
  /** WP56：溯源等级（读取时派生，见 `KnowledgeProvenanceGrade`）。 */
  provenance_grade?: KnowledgeProvenanceGrade
  /** WP56：`stale` 的条目照常返回，只是排在后面——调用方据此约束 prompt 措辞。 */
  verification?: Exclude<KnowledgeVerificationState, 'quarantined'>
  /** WP56：最后核实日期；**为空就是没记录**，不要用 `created_at` 顶替。 */
  last_verified_at?: Iso8601
  /** WP56：这条知识管售前还是售后。 */
  stage?: KnowledgeStage
}

/**
 * WP56（48 §4 #7）：检索档。
 *
 * - `context` **长上下文优先**：全库（按身份过滤之后）字符数 ≤ 预算就整库注入，
 *   不检索、不打分——中小卖家的知识库基本都落在这一档，于是没有召回损失，
 *   也不需要向量库；
 * - `lexical`：超预算才退回关键词检索 + 溯源分层装箱；
 * - `hybrid`：留的接口（BM25 + 向量 RRF），本期**不实现**，选到它按 `lexical` 跑。
 */
export type RetrievalTier = 'context' | 'lexical' | 'hybrid'
export type RetrievalMode = 'auto' | RetrievalTier

/** 19 §3：先按身份过滤候选再算相似度（过滤下推）；precheck 不读正文不计 usage。 */
export interface Retrieval {
  search(q: {
    text: string
    actor: RetrievalActor
    domains?: (DataDomain | 'company')[]
    scope?: RangeRef[]
    layers?: KnowledgeLayer[]
    k?: number
    precheck?: boolean
    /** WP56（48 §3 L2）：这次问的是售前还是售后；不给就不按适用范围过滤。 */
    stage?: KnowledgeStage
    /** WP56（48 §4 #7）：检索档；缺省 `auto`（按库的大小自己定）。 */
    mode?: RetrievalMode
    /** WP56：长上下文档的字符预算；缺省 16000，工作区可覆盖。 */
    budget_chars?: number
  }): Promise<{
    hits: RetrievalHit[]
    relevant: boolean
    matched: string[]
    missing: string[]
    /** WP56：这一次实际走了哪一档（`context` 时 `matched` / `missing` 不作数）。 */
    tier?: RetrievalTier
  }>
  cite(fact_card_id: string, run_id: RunId): Promise<void>
}

export interface KnowledgeStore {
  propose(
    card: Omit<FactCard, 'id' | 'status' | 'usage' | 'created_at' | 'updated_at'>,
  ): Promise<FactCard>
  activate(id: string, by: PersonId): Promise<FactCard>
  retire(id: string, by: PersonId): Promise<FactCard>
  get(id: string, actor: RetrievalActor): Promise<FactCard | undefined>
  list(
    filter: {
      workspace_id: WorkspaceId
      domain?: string
      layer?: KnowledgeLayer
      status?: FactCard['status']
    },
    actor: RetrievalActor,
  ): Promise<FactCard[]>
  health(
    workspace_id: WorkspaceId,
  ): Promise<{ total: number; silent: number; stale: number; conflicts: number }>
}

/** 19 §1.2 运行记忆（Commerce Agents A7）：小、类型化、有上限、可撤销；写过滤拒秘密。 */
export interface MemoryFactRecord {
  key: string
  value: string
  category: 'constraint' | 'preference' | 'context'
  subject: ObjectRef
  source_run_hash: string
  expires_at: Iso8601
  workspace_id: WorkspaceId
}
export interface MemoryStore {
  /** 返回被写过滤拒绝的条目与原因 */
  write(facts: MemoryFactRecord[]): Promise<{
    accepted: MemoryFactRecord[]
    rejected: { fact: MemoryFactRecord; reason: string }[]
  }>
  recall(
    subject: ObjectRef,
    opts?: { cap?: number; workspace_id?: WorkspaceId },
  ): Promise<MemoryFactRecord[]>
  forget(subject: ObjectRef, key: string, opts?: { workspace_id?: WorkspaceId }): Promise<void>
}

/**
 * WP224（Luoye 10-05）：**按职责白名单才看得到**的那几类事实卡（`subject.type` → 职责 id）。
 *
 * 19 §3 的过滤下推原来只按数据域 / 敏感度 / 范围切；这里加最小的一刀：在表里的
 * `subject.type`，只有白名单里的职责检索得到、`get` / `list` 得到（过滤下推，不是命中后脱敏）。
 * 不在表里的照旧。只加不删。
 */
export const ROLE_SCOPED_FACT_SUBJECTS: Readonly<Record<string, readonly string[]>> = {
  [GROSS_MARGIN_SUBJECT_TYPE]: GROSS_MARGIN_VISIBLE_ROLES,
}

/* ── WP322（docs/102 §5.4，决策 670）：FAQ 表导入。**只加不删** ──────────── */

/** FAQ 卡的 `subject.type`（一行问答一张卡；`subject.key` = `faq:<归一化后的问题>`）。 */
export const FAQ_SUBJECT_TYPE = 'faq'

/** 表里认的五种列。 */
export type FaqField = 'question' | 'answer' | 'category' | 'product' | 'language'

/** 一张工作表怎么对：哪一行是表头、每种列在第几列（0 起）。 */
export interface FaqSheetMapping {
  /** 工作表名（csv 是空串）。 */
  sheet: string
  /** 表头在第几行（Excel 行号，1 起）。 */
  header_row: number
  columns: { field: FaqField; col: number; header: string }[]
  /** 这张表里能导的行数（有问题也有答案的）。 */
  rows: number
  /** 谁对的：规则一眼认出来的，还是 AI 读表头判的。 */
  by: 'rules' | 'ai'
}

/** 「定规矩」卡（`policy_change` + `form: 'faq_import'`）上的选项：记下 / 只加新的 / 不用；只删了行时是撤下 / 留着。 */
export type FaqImportOption = 'all' | 'new_only' | 'skip' | 'retire'

/**
 * 「这份表按问答导入」那张卡的载荷：映射 + 一两行预览 + 和库里比的结果。
 * 行本身不进载荷——批了服务端按 `source_id` 重读原件（载荷不背整张表）。
 */
export interface FaqImportPayload {
  form: 'faq_import'
  source_id: string
  filename: string
  sheets: FaqSheetMapping[]
  counts: { new: number; changed: number; same: number; removed: number; skipped: number }
  preview: { question: string; answer: string }[]
  /** 答案变了的前几条（改之前 / 改之后）。 */
  changes: { question: string; before: string; after: string }[]
  /** 上一次从同名表导入、这次表里没有了的前几条问题（卡不动，只提示）。 */
  removed: string[]
  options: { id: FaqImportOption; label: string }[]
}

/**
 * ③ 公司模式：导入的卡落成 `proposed` 之后，给负责人的那一张「改东西」卡
 * （`knowledge_update` + `form: 'faq_batch'`）。通过 = 整批生效（答案变了的顶掉旧的）；不要 = 整批作废。
 */
export interface FaqBatchPayload {
  form: 'faq_batch'
  source_id: string
  filename: string
  /** 这一批新建的卡（都是 `proposed`）。 */
  card_ids: string[]
  /** 通过之后要退役的旧卡（新卡 id → 被它顶掉的旧卡 id）。 */
  replaces: Record<string, string>
  counts: { new: number; changed: number }
  preview: { question: string; answer: string }[]
  before: null
  after: string
}

/**
 * WP350（决策 900）：「我的助理」把一份资料拆给几个岗位时，要记的那几条（已以 `proposed` 写进知识库，
 * 出处 = 这份资料）等人确认的那**一张**卡（`knowledge_update` + `form: 'assistant_notes'`）。
 * 通过 = 这一批全部生效；不要 = 这一批全部作废（退役留痕，不删）。
 */
export const ASSISTANT_NOTES_FORM = 'assistant_notes'

export interface AssistantNotesPayload {
  form: 'assistant_notes'
  /** 来源批次（方案卡那一批）。 */
  batch_id: string
  /** 资料叫什么。 */
  source: string
  card_ids: string[]
  /** 按岗位（品牌公共也算一组）：几条、每条正文与原文出处。 */
  groups: { name: string; notes: { text: string; quote?: string }[] }[]
  before: null
  after: string
}

export const isAssistantNotesPayload = (p: unknown): p is AssistantNotesPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === ASSISTANT_NOTES_FORM &&
  Array.isArray((p as { card_ids?: unknown }).card_ids)

/* ── WP488（决策 1680–1682、1686）：从过往邮件 / 官网 / 售后网站学，公共 / 售前 / 售后三份。**只加不删** ── */

/** 从过往邮件学：默认回看几个月（决策 1686；卡上能改）。 */
export const DEFAULT_EMAIL_LOOKBACK_MONTHS = 12
/** 回看月数的上下限。 */
export const EMAIL_LOOKBACK_MONTHS_MAX = 36

/** 三份的标签页顺序：公共（= `both`）/ 售前 / 售后。 */
export const KNOWLEDGE_STAGES: readonly KnowledgeStage[] = ['both', 'presales', 'postsales']

export const isKnowledgeStage = (v: unknown): v is KnowledgeStage =>
  v === 'both' || v === 'presales' || v === 'postsales'

/** 没标的就是公共（存量卡一条不用改）。 */
export const stageOf = (card: { stage?: KnowledgeStage | undefined }): KnowledgeStage =>
  card.stage ?? 'both'

/**
 * 售后的信号：已经买了（订单号 / 我的订单 / 收到了 / 坏了 / 退款进度 / 物流到哪）。
 * 只认**强信号**——「退货政策是什么」这种买之前也会问的不算。
 */
const POSTSALES_RE =
  /\b(?:my|the|this)\s+(?:order|package|parcel|shipment|delivery|refund|replacement)\b|\border\s*(?:#|no\.?|number|id)\s*[:：]?\s*[A-Z0-9-]{3,}|#\s?\d{4,}|\b(?:tracking|track(?:ing)?\s+number|where\s+is\s+my|hasn'?t\s+arrived|not\s+(?:yet\s+)?(?:arrived|received|delivered)|i\s+(?:received|got|bought|ordered|purchased)|arrived\s+(?:damaged|broken)|damaged|broken|defective|missing\s+item|wrong\s+item|return\s+label|refund\s+status|cancel\s+my\s+order|change\s+(?:my\s+)?(?:shipping\s+)?address)\b|我的订单|订单号|已(?:经)?(?:下单|付款|购买|买了|收到)|收到(?:了|的)|还没(?:收到|到)|物流(?:到哪|单号|信息)|快递(?:到哪|单号)|坏了|破损|少发|错发|漏发|退款进度|改地址|取消订单/i

/** 售前的信号：还没买（价格 / 折扣 / 选型 / 兼容 / 有没有货 / 下单前）。 */
const PRESALES_RE =
  /\b(?:how\s+much|price|pricing|cost|discount|coupon|promo(?:tion)?\s*code|bulk|wholesale|in\s+stock|available|availability|which\s+(?:one|model|size|version)|difference\s+between|compare|compatible|compatibility|does\s+it\s+(?:fit|work|support|come)|before\s+(?:i\s+)?(?:buy|order|purchas)|planning\s+to\s+(?:buy|order)|thinking\s+(?:of|about)\s+(?:buying|ordering)|pre-?order|recommend)\b|多少钱|价格|报价|优惠|折扣|有货|现货|库存|哪(?:款|个型号)|区别|兼容|适合|推荐|下单前|买之前|想买|打算买|预售/i

/**
 * WP488（决策 1682）：这段话是售前还是售后（**规则判，不问模型**）。
 *
 * 已有订单号 / 已购 / 物流售后词 → 售后；询价 / 选型 / 发货前 → 售前；两边都像或都不像 → `undefined`
 * （取用方按「判不出 → 两边都取」处理；学的时候判不出给 `both`）。
 */
export function stageOfText(text: string): Exclude<KnowledgeStage, 'both'> | undefined {
  const post = POSTSALES_RE.test(text)
  const pre = PRESALES_RE.test(text)
  if (post && !pre) return 'postsales'
  if (pre && !post) return 'presales'
  return undefined
}

/** 学的时候用：模型给的范围认得就用，认不得按规则判，规则也判不出给 `both`。 */
export function resolveStage(given: unknown, text: string): KnowledgeStage {
  if (isKnowledgeStage(given)) return given
  return stageOfText(text) ?? 'both'
}

/* ── WP495（1701）：哪几条**真写了承诺**——只给它们挂小图标。规则判，不问模型 ── */

/**
 * 承诺词：退款 / 退货 / 换货、保修 / 质保、赔付 / 补发 / 换新、价格保证（保价 / 退差价 / price match）。
 * 光是「发货 3–5 天」「价格 $29」不算承诺——那是事实，不是我们答应客户的事。
 */
const COMMITMENT_WORD_RE =
  /\b(?:refund(?:s|ed|able)?|returns?|returnable|exchanges?|warrant(?:y|ies|ied)|guarantee[ds]?|money[-\s]?back|compensat(?:e|ed|ion)|reimburs(?:e|ed|ement)|replace(?:d|ment|ments)?|resend|re-?ship|price[-\s]?(?:match|protection|adjustment|guarantee))\b|退款|退货|换货|退换|包退|包换|保修|质保|保固|保换|赔偿|赔付|补偿|补发|重发|换新|价保|保价|价格保证|退差价|补差价/i

/** 数字 + 期限 / 比例 / 金额（「30 days」「1 year」「100%」「$20」「7天」「七天」「一年」「20 元」）。 */
const COMMITMENT_QUANTITY_RE =
  /\b\d+(?:\.\d+)?\s*(?:-|to|–)?\s*(?:\d+\s*)?(?:business\s+|working\s+|calendar\s+)?(?:days?|weeks?|months?|years?|yrs?|hours?|hrs?)\b|\b(?:one|two|three|five|seven|ten|fourteen|fifteen|thirty|sixty|ninety)\s*[-\s]\s*(?:days?|weeks?|months?|years?)\b|\d+(?:\.\d+)?\s*%|[$€£¥]\s*\d|\b\d+(?:\.\d+)?\s*(?:usd|eur|gbp|dollars?)\b|\d+\s*(?:个)?(?:工作日|天|日|周|星期|个月|月|年|小时)|[一二两三四五六七八九十百]+\s*(?:个)?(?:工作日|天|日|周|星期|个月|月|年|小时)|\d+(?:\.\d+)?\s*(?:元|美元|欧元|英镑)/i

/** 不带数字、本身就是承诺的说法（全额退款 / 免费换新 / 终身保修 / 无理由退货）。 */
const COMMITMENT_ABSOLUTE_RE =
  /\b(?:full|100%)\s+refund|\bmoney[-\s]?back\s+guarantee|\blifetime\s+(?:warranty|guarantee)|\bfree\s+(?:returns?|replacements?|exchanges?|resend|reship)|\bno[-\s]questions?[-\s]asked\b|全额退款|全额退|免费(?:退|换|补发|重发|换新|维修|保修)|终身保修|终身质保|无理由退/i

/** 一句一句看（承诺词与数字得在同一句里，免得「发货 3 天。退货请联系我们。」被凑成一条承诺）。 */
const SENTENCE_SPLIT_RE = /(?<=[.!?;])\s+|(?<=[。！？；])\s*|\n+/

/**
 * WP495（1701）：这段话里有没有**真写了承诺**——退款 / 退货天数、保修期、赔付 / 补发、价格保证。
 *
 * 判据：同一句里「承诺词 + 数字（期限 / 比例 / 金额）」，或者一句本身就是承诺的说法（全额退款、终身保修…）。
 * 只有政策主题、没写具体答应什么（「退货请联系客服」）的不算。
 */
export function hasCommitment(text: string): boolean {
  const normalized = text.normalize('NFKC')
  for (const sentence of normalized.split(SENTENCE_SPLIT_RE)) {
    if (sentence.trim() === '') continue
    if (COMMITMENT_ABSOLUTE_RE.test(sentence)) return true
    if (COMMITMENT_WORD_RE.test(sentence) && COMMITMENT_QUANTITY_RE.test(sentence)) return true
  }
  return false
}

/** 学的是哪一种来源。 */
export type KnowledgeLearnSource = 'email' | 'website'

/** 汇总卡（`knowledge_update` + `form: 'knowledge_learned'`）。 */
export const KNOWLEDGE_LEARNED_FORM = 'knowledge_learned'

/** 汇总卡上的一条（卡早已以 `proposed` 写进知识库，批了才生效）。 */
export interface KnowledgeLearnedItem {
  card_id: string
  question: string
  answer: string
  stage: KnowledgeStage
  /** 依据：几封往来 / 哪一页（给人看的一句）。 */
  basis: string
  /** 政策敏感 / 带承诺 / 没脱敏——要多看一眼。 */
  hold?: boolean
  /**
   * WP495（1701）：答案里**真写了承诺**（退款 / 退货天数、保修期、赔付 / 补发、价格保证）——卡上只给这几条挂小图标。
   * 规则判（{@link hasCommitment}），不问模型。老卡没有这一格，界面按答案原文现判。
   */
  commitment?: boolean
}

export interface KnowledgeLearnedPayload {
  form: typeof KNOWLEDGE_LEARNED_FORM
  job_id: string
  source: KnowledgeLearnSource
  card_ids: string[]
  items: KnowledgeLearnedItem[]
  /**
   * 人在卡上改过的范围（`approve` + `edited_payload`：卡 id → 范围）；
   * 和不要的那几条（卡 id）。服务端只认这两处改动。
   */
  stages?: Record<string, KnowledgeStage>
  drop?: string[]
  before: null
  after: string
}

export const isKnowledgeLearnedPayload = (p: unknown): p is KnowledgeLearnedPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === KNOWLEDGE_LEARNED_FORM &&
  Array.isArray((p as { items?: unknown }).items)

/** 「这几条可能过期」卡（`knowledge_update` + `form: 'knowledge_stale'`）。 */
export const KNOWLEDGE_STALE_FORM = 'knowledge_stale'

export interface KnowledgeStalePayload {
  form: typeof KNOWLEDGE_STALE_FORM
  recheck_ids: string[]
  /**
   * 人在卡上选的（`approve` + `edited_payload.resolution`）：`unchanged` = 确认没变；
   * `relearn` = 按网站上的新内容重学这几页（旧的几条撤下，新学到的再出一张汇总卡）。不要 = 忽略。
   */
  resolution?: 'unchanged' | 'relearn'
  /** 复查是哪条职责跑的（重学时用它问模型）。 */
  assignment_id?: string
  items: { recheck_id: string; card_id: string; statement: string; url: string; change: string }[]
  before: null
  after: string
}

export const isKnowledgeStalePayload = (p: unknown): p is KnowledgeStalePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === KNOWLEDGE_STALE_FORM &&
  Array.isArray((p as { recheck_ids?: unknown }).recheck_ids)

/**
 * WP506（决策 1796 C）：**AI 提议停用 / 启用几条知识**的确认卡（`knowledge_update` + `form: 'knowledge_toggle'`）。
 *
 * AI 只能提、不能改：它调 `propose_knowledge_toggle` 出这一张，列出是哪几条、为什么；人在中栏点了才真停用 / 启用
 * （走和知识库面板同一处 `setDisabled`）。不批什么都不变；批了之后卡上还能「撤销」（人点，走只给人点的那个接口）。
 */
export const KNOWLEDGE_TOGGLE_FORM = 'knowledge_toggle'

export interface KnowledgeTogglePayload {
  form: typeof KNOWLEDGE_TOGGLE_FORM
  action: 'disable' | 'enable'
  /** AI 给的理由（一句话，外来文字照资料对待）。 */
  reason: string
  items: { id: string; statement: string; stage?: KnowledgeStage }[]
  before: null
  after: string
}

export const isKnowledgeTogglePayload = (p: unknown): p is KnowledgeTogglePayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === KNOWLEDGE_TOGGLE_FORM &&
  ((p as { action?: unknown }).action === 'disable' ||
    (p as { action?: unknown }).action === 'enable') &&
  Array.isArray((p as { items?: unknown }).items)

/** 开跑前的预估（花费跟簇数 / 页数走；模型网关的上限照算）。 */
export interface KnowledgeLearnEstimate {
  source: KnowledgeLearnSource
  /** 邮件：回看几个月。 */
  months?: number
  /** 网站：要读的入口。 */
  urls?: string[]
  /** 邮件：拼出来几对「客户问 → 我们答」。 */
  pairs?: number
  /** 邮件：成了几簇（= 问几次模型）。网站：最多读几页（= 最多问几次模型）。 */
  calls: number
  /** 预估花费（模型网关的计价单位；本机免费模型 / 没价就不给）。 */
  cost?: number
  /** 网关这个月的用量与上限（有上限才给）。 */
  budget?: { used: number; cap: number }
  /** 装不装得下（没上限 = 装得下）。 */
  fits: boolean
  /** 邮件：接没接邮箱。 */
  connected?: boolean
  /** 模型能不能用（没接模型就学不了）。 */
  model: boolean
}

export type KnowledgeLearnState =
  | 'running'
  | 'done'
  | 'failed'
  | 'needs_connection'
  | 'over_budget'
  | 'no_model'

/** 一次「学一遍」（服务进程内存里；结果在知识库与汇总卡上）。 */
export interface KnowledgeLearnJob {
  id: string
  workspace_id: WorkspaceId
  source: KnowledgeLearnSource
  state: KnowledgeLearnState
  months?: number
  urls?: string[]
  /** 走到哪一步了（第几簇 / 第几页，共几个）。 */
  progress: { done: number; total: number }
  /** 学到几条（都是待确认）。 */
  learned: number
  estimate?: KnowledgeLearnEstimate
  matter_id?: string
  approval_id?: string
  /** 连接卡（没接邮箱时）。 */
  connect_card_id?: string
  /** 给人看的一句（失败原因 / 为什么只学到这几条）。 */
  note?: string
  started_at: Iso8601
  finished_at?: Iso8601
}
