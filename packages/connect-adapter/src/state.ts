import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AssignmentId,
  Connection,
  ConnectToken,
  Iso8601,
  WorkspaceId,
} from '@agentsws/contracts'
import { secretKey } from './secrets.js'

/**
 * 本地 token → assignment 映射。
 *
 * 上游的持久 runtime token **没有有效期**（实测 `POST /api/runtime-tokens` 的记录里只有
 * `createdAt`），所以"到期即失效"必须由我们记账并在 `execute` 前把关。
 * 表里**只存 token 的 sha256**，原文不落盘、不进内存表。
 */
export interface TokenRecord {
  /** sha256(token)，主键；原文不存。 */
  token_sha256: string
  /** 上游 runtime token 记录 id，用于 DELETE。 */
  runtime_token_id: string
  kind: ConnectToken['kind']
  assignment_id: AssignmentId
  allowed_actions: string[]
  allowed_connections: string[]
  /** 18 §1：恒为空。 */
  allowed_proxies: string[]
  issued_at: Iso8601
  expires_at: Iso8601
  revoked: boolean
}

/** 连接的 workspace / ownership 归属——上游没有这两个概念，由我们维护（08 §2.5、18 §4）。 */
export interface ConnectionMeta {
  connection_id: string
  workspace_id: WorkspaceId
  ownership: Connection['ownership']
  owner_person_id?: string
  status_override?: Connection['status']
}

export interface AdapterStateFile {
  version: 1
  tokens: TokenRecord[]
  connections: ConnectionMeta[]
}

/** 内存 + 可选文件。文件里没有任何凭据原文。 */
export class AdapterState {
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly conns = new Map<string, ConnectionMeta>()

  constructor(private readonly file?: string | undefined) {
    if (file === undefined) return
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return
    }
    const parsed = JSON.parse(text) as AdapterStateFile
    for (const t of parsed.tokens ?? []) this.tokens.set(t.token_sha256, t)
    for (const c of parsed.connections ?? []) this.conns.set(c.connection_id, c)
  }

  putToken(token: string, record: Omit<TokenRecord, 'token_sha256'>): TokenRecord {
    const full: TokenRecord = { ...record, token_sha256: secretKey(token) }
    this.tokens.set(full.token_sha256, full)
    this.flush()
    return full
  }

  findToken(token: string): TokenRecord | undefined {
    return this.tokens.get(secretKey(token))
  }

  tokensOf(assignment_id: AssignmentId): TokenRecord[] {
    return [...this.tokens.values()].filter((t) => t.assignment_id === assignment_id)
  }

  allTokens(): TokenRecord[] {
    return [...this.tokens.values()]
  }

  markRevoked(assignment_id: AssignmentId): TokenRecord[] {
    const hit = this.tokensOf(assignment_id)
    for (const t of hit) t.revoked = true
    this.flush()
    return hit
  }

  putConnectionMeta(meta: ConnectionMeta): ConnectionMeta {
    this.conns.set(meta.connection_id, meta)
    this.flush()
    return meta
  }

  connectionMeta(id: string): ConnectionMeta | undefined {
    return this.conns.get(id)
  }

  allConnectionMeta(): ConnectionMeta[] {
    return [...this.conns.values()]
  }

  snapshot(): AdapterStateFile {
    return {
      version: 1,
      tokens: this.allTokens().map((t) => ({ ...t })),
      connections: this.allConnectionMeta().map((c) => ({ ...c })),
    }
  }

  private flush(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8')
  }
}
