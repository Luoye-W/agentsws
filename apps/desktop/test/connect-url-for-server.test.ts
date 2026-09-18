/**
 * WP111：打包之后一定给服务进程一个 `AGENTSWS_CONNECT_URL`。
 *
 * 不给 = 服务进程走开发替身，连接页上点一下就"连上了"——全是假的。
 * 开发期那正是我们要的；到了内测用户的机器上那是骗人。
 */
import { describe, expect, it } from 'vitest'
import { CONNECT_STANDIN_ENV, connectUrlForServer } from '../src/connect-runtime.js'

const FALLBACK = 'http://127.0.0.1:3000'

describe('connectUrlForServer', () => {
  it('打包版：没设变量也给一个值 —— 走真路径，Docker 没装就把卡置灰', () => {
    expect(connectUrlForServer({ env: {}, packaged: true, fallback: FALLBACK })).toBe(FALLBACK)
  })

  it('开发期：不给 —— 替身档照旧（demo 与 e2e 靠它）', () => {
    expect(connectUrlForServer({ env: {}, packaged: false, fallback: FALLBACK })).toBeUndefined()
  })

  it('显式设了就用显式的（两档都一样）', () => {
    const env = { AGENTSWS_CONNECT_URL: 'http://127.0.0.1:9000' }
    expect(connectUrlForServer({ env, packaged: true, fallback: FALLBACK })).toBe(
      'http://127.0.0.1:9000',
    )
    expect(connectUrlForServer({ env, packaged: false, fallback: FALLBACK })).toBe(
      'http://127.0.0.1:9000',
    )
  })

  it('空串当没设（`AGENTSWS_CONNECT_URL=` 是常见的手抖）', () => {
    expect(
      connectUrlForServer({
        env: { AGENTSWS_CONNECT_URL: '  ' },
        packaged: true,
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK)
  })

  it('逃生口：打包版里也能退回替身（演示用）', () => {
    expect(
      connectUrlForServer({
        env: { [CONNECT_STANDIN_ENV]: '1' },
        packaged: true,
        fallback: FALLBACK,
      }),
    ).toBeUndefined()
  })

  it('逃生口压不过显式地址 —— 两个都设了，听地址的', () => {
    expect(
      connectUrlForServer({
        env: { [CONNECT_STANDIN_ENV]: '1', AGENTSWS_CONNECT_URL: 'http://127.0.0.1:9000' },
        packaged: true,
        fallback: FALLBACK,
      }),
    ).toBe('http://127.0.0.1:9000')
  })
})
