/**
 * 40 §1.2 第一条规则：**个人电脑上不存真源**（WP36 交付 5）。
 *
 * 「桌面壳和浏览器只是客户端；离线草稿只在本机缓存，联网即同步。」
 * 这条规则很容易在某次"顺手做个离线缓存"里悄悄破掉——把订单、事项、待办、
 * 审批项写进 IndexedDB，界面看起来更快了，而公司库从那一刻起不再是唯一真源：
 * 两边不一致的时候谁对？人走了那台电脑上还留着什么？
 *
 * 所以这一组用例不是测某个函数，是**钉住一条边界**：
 *
 * 1. 工作台**一行 IndexedDB / Cache Storage 都不用**；
 * 2. 只有两个文件碰得到 `localStorage`，键必须在白名单里；
 * 3. 跑一圈真实的数据读取（待办、事项、审批、成员）之后，
 *    `localStorage` 里除了白名单那几个键，一个字节都不多。
 *
 * 白名单只有三类：**偏好**（主题、语言）、**会话凭据**（不是业务对象，
 * 而且它本来就该只活在这台机器上）、**未发送的草稿**（`agentsws.draft.*`，
 * 40 §1.2 明确允许的那一类）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToken, listMatters, listMembers, listTodos } from '@/lib/api'

// jsdom 里 `import.meta.url` 不是 file: URL，所以从 vitest 的项目根走
const SRC = process.cwd().endsWith('workstation')
  ? join(process.cwd(), 'src')
  : join(process.cwd(), 'apps', 'workstation', 'src')

/** 允许落在这台电脑上的键。加一条就要在这里加一条，并说清它为什么不是业务对象。 */
const ALLOWED_KEYS = [
  'agentsws.theme', // 偏好：深浅色
  'agentsws.lang', // 偏好：界面语言
  'agentsws.session_token', // 会话凭据：不是业务对象，且本来就只该活在本机
]
/** 未发送的草稿走这个前缀（40 §1.2 明确允许的那一类）。 */
const DRAFT_PREFIX = 'agentsws.draft.'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const allowed = (key: string): boolean => ALLOWED_KEYS.includes(key) || key.startsWith(DRAFT_PREFIX)

describe('40 §1.2 第一条规则：个人电脑上不存真源', () => {
  const files = sourceFiles(SRC)

  it('一行 IndexedDB / Cache Storage / WebSQL 都不用', () => {
    const offenders = files.filter((path) =>
      /\bindexedDB\b|\bIDBDatabase\b|\bopenDatabase\b|caches\.open/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    expect(offenders.map((p) => p.slice(SRC.length + 1))).toEqual([])
  })

  it('只有两个文件碰得到 localStorage / sessionStorage', () => {
    const touching = files
      .filter((path) => /\b(localStorage|sessionStorage)\b/.test(readFileSync(path, 'utf8')))
      .map((p) => p.slice(SRC.length + 1))
      .sort()
    // 一个存偏好，一个存会话凭据；多出第三个就要在这里说清它存的是什么
    expect(touching).toEqual(['lib/api.ts', 'lib/app-context.tsx'])
  })

  it('源码里出现的每一个 agentsws.* 存储键都在白名单里', () => {
    const keys = new Set<string>()
    for (const path of files) {
      for (const m of readFileSync(path, 'utf8').matchAll(/['"`](agentsws\.[a-z_.]+)['"`]/g)) {
        const key = m[1]
        if (key !== undefined) keys.add(key)
      }
    }
    expect([...keys].filter((k) => !allowed(k))).toEqual([])
  })
})

/** 一个看得见内部的 localStorage 替身：这一组用例要数的就是"它里面多了什么"。 */
function fakeStorage(): Storage & { entries(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => {
      map.clear()
    },
    entries: () => Object.fromEntries(map),
  }
}

describe('跑一圈真实的数据读取之后，本机什么都没多出来', () => {
  const fetchMock = vi.fn()
  let store = fakeStorage()

  beforeEach(() => {
    store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.includes('/members')
        ? [{ person_id: 'p_1', name: '李默', email: 'limo@example.com' }]
        : url.includes('/todos')
          ? { todos: [{ id: 'td_1', title: '一件在办的事', owner: 'p_1' }] }
          : { matters: [{ id: 'mat_1', title: '一件在办的事' }] }
      return Promise.resolve(
        new Response(JSON.stringify({ data, trace_id: 'tr_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('待办 / 事项 / 成员都读回来了，localStorage 里只有白名单那几个键', async () => {
    const todos = await listTodos()
    const matters = await listMatters()
    const members = await listMembers('ws_1')
    expect(todos.todos).toHaveLength(1)
    expect(matters.matters).toHaveLength(1)
    expect(members[0]?.name).toBe('李默')

    const entries = store.entries()
    expect(Object.keys(entries).filter((k) => !allowed(k))).toEqual([])
    // 业务对象一个字都没落到本机
    const dump = Object.values(entries).join('|')
    expect(dump).not.toContain('一件在办的事')
    expect(dump).not.toContain('李默')
  })
})
