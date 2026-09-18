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
