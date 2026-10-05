/**
 * WP232（10-05 真模型实测）：草稿跟来信语言写对了，过程话也跟着成了英文。
 * 起草工具的描述与参数说明（模型填参数那一刻读它）把「只有这份外发稿跟来信语言」写死，
 * dsh 与 direct 同一份字节；没建成卡的原因不再写「未获批准（fail-closed）」。
 */
import {
  DRAFT_BODY_DESCRIPTION,
  DRAFT_NOT_CREATED,
  DRAFT_TOOL_DESCRIPTION,
} from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { buildToolDefinitions, DRAFT_TOOL } from '../src/index.js'
import { makeRequest } from './helpers.js'

describe('WP232：dsh 的起草工具', () => {
  it('描述与参数说明：当场建卡不等人；正文跟来信语言，对用户说的话不跟', () => {
    const noop = {
      run: async () => ({ status: 'ok' as const }),
      note: () => undefined,
      provenance: () => undefined,
    }
    const defs = buildToolDefinitions(makeRequest({ allow: ['get_order'] }), noop, {
      stage: async () => undefined,
      draft: async () => undefined,
    })
    const draft = defs.find((d) => d.name === DRAFT_TOOL)
    expect(draft?.description).toBe(DRAFT_TOOL_DESCRIPTION)
    expect(DRAFT_TOOL_DESCRIPTION).toContain('nobody needs to be online')
    const params = JSON.stringify(draft?.parameters)
    expect(params).toContain(DRAFT_BODY_DESCRIPTION)
    expect(DRAFT_BODY_DESCRIPTION).toContain('language of the message being answered')
    expect(DRAFT_BODY_DESCRIPTION).toContain('what you say to the user stays')
  })

  it('没建成卡：照实说没有卡在等人批，不再写「未获批准（fail-closed）」', async () => {
    const noop = {
      run: async () => ({ status: 'ok' as const }),
      note: () => undefined,
      provenance: () => undefined,
    }
    const defs = buildToolDefinitions(makeRequest({ allow: ['get_order'] }), noop, {
      stage: async () => undefined,
      draft: async () => undefined,
    })
    const draft = defs.find((d) => d.name === DRAFT_TOOL)
    const exec = { callId: 'call_1' } as never
    await expect(
      (draft as unknown as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute(
        { subject: 'Re', body: 'Hi' },
        exec,
      ),
    ).rejects.toThrow(DRAFT_NOT_CREATED)
    expect(DRAFT_NOT_CREATED).not.toContain('fail-closed')
    expect(DRAFT_NOT_CREATED).toContain('没有任何卡在等人批')
  })
})
