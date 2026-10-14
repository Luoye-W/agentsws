/** WP321（决策 534）：自带 key 那档问 Claude 前查一次免费的模型清单（替身响应，不联网）。 */
import { describe, expect, it } from 'vitest'
import { dataforseo } from '../src/providers/dataforseo.js'
import { fakeFetch } from './search-fakes.js'

const KEY = 'test-login:not-a-real-password'

describe('WP321 Claude 模型清单', () => {
  it('打免费的清单口（GET）、读出模型名；别的平台不查', async () => {
    const { fetch, calls } = fakeFetch([
      [
        '/ai_optimization/claude/llm_responses/models',
        {
          body: {
            status_code: 20000,
            tasks: [
              {
                status_code: 20000,
                result: [
                  { model_name: 'claude-sonnet-5', web_search_supported: true },
                  { model_name: 'claude-haiku-4-5' },
                ],
              },
            ],
          },
        },
      ],
    ])
    expect(await dataforseo.models?.('claude', KEY, fetch)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ])
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.url).toBe(
      'https://api.dataforseo.com/v3/ai_optimization/claude/llm_responses/models',
    )
    expect(await dataforseo.models?.('chatgpt', KEY, fetch)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('key 不对：照常抛（调用方跳过 Claude 并说一句）', async () => {
    const { fetch } = fakeFetch([
      [
        '/models',
        {
          body: { status_code: 20000, tasks: [{ status_code: 40100, status_message: 'bad key' }] },
        },
      ],
    ])
    await expect(dataforseo.models?.('claude', KEY, fetch)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })
})
