/**
 * WP184：官方场景窗口的判断（移植自官方桌面端 MIT 的做法，见 `src/scene-window.ts` 头注）。
 */
import { describe, expect, it } from 'vitest'
import {
  authenticateSceneHost,
  decideScenePermission,
  isDevToolsShortcut,
  type SceneOwner,
  sceneEntry,
  sceneRequestHeaders,
  sceneSender,
  sceneWindowTitle,
  withoutSetCookie,
} from '../src/scene-window.js'

const owner: SceneOwner = {
  webContentsId: 7,
  origin: 'http://127.0.0.1:5123',
  cookie: 'dsh_session_abc=signed',
}

describe('换 cookie：带 token 的网址只在主进程里用一次', () => {
  it('303 + set-cookie → 只留 name=value；别的样子一律不认', async () => {
    const seen: string[] = []
    const ok = await authenticateSceneHost('http://127.0.0.1:5123/?token=t', async (url, init) => {
      seen.push(`${url} ${init.redirect}`)
      return {
        status: 303,
        headers: {
          get: (n) => (n === 'set-cookie' ? 'dsh_session_abc=signed; Path=/; HttpOnly' : null),
        },
      }
    })
    expect(ok).toBe('dsh_session_abc=signed')
    expect(seen).toEqual(['http://127.0.0.1:5123/?token=t manual'])
    await expect(
      authenticateSceneHost('http://x', async () => ({
        status: 401,
        headers: { get: () => null },
      })),
    ).rejects.toThrow()
    await expect(
      authenticateSceneHost('http://x', async () => ({
        status: 303,
        headers: { get: () => null },
      })),
    ).rejects.toThrow()
  })

  it('窗口加载的是去掉 token 的干净网址；只认回环 http', () => {
    expect(sceneEntry('http://127.0.0.1:5123/?token=secret')).toEqual({
      origin: 'http://127.0.0.1:5123',
      entry: 'http://127.0.0.1:5123/',
    })
    expect(sceneEntry('http://0.0.0.0:5123/?token=x')).toBeUndefined()
    expect(sceneEntry('https://127.0.0.1:5123/')).toBeUndefined()
    expect(sceneEntry('http://127.0.0.1/')).toBeUndefined()
    expect(sceneEntry('nope')).toBeUndefined()
  })
})

describe('凭据只附给归属窗口', () => {
  const base = { requestHeaders: { Origin: 'http://127.0.0.1:5123', Cookie: 'page=1' } }
  it('归属窗口发往自己的主机：换上主进程那枚 cookie（页面自己的丢掉）', () => {
    expect(
      sceneRequestHeaders({
        ...base,
        url: 'ws://127.0.0.1:5123/api/stream',
        webContentsId: 7,
        owners: [owner],
      }),
    ).toEqual({
      action: 'attach',
      requestHeaders: { origin: 'http://127.0.0.1:5123', cookie: 'dsh_session_abc=signed' },
    })
  })
  it('别的窗口、别的主机：原样放行，不补凭据', () => {
    expect(
      sceneRequestHeaders({
        ...base,
        url: 'ws://127.0.0.1:5123/',
        webContentsId: 8,
        owners: [owner],
      }),
    ).toEqual({ action: 'pass' })
    expect(
      sceneRequestHeaders({
        ...base,
        url: 'http://127.0.0.1:9999/',
        webContentsId: 7,
        owners: [owner],
      }),
    ).toEqual({ action: 'pass' })
    expect(
      sceneRequestHeaders({
        ...base,
        url: 'http://127.0.0.1:5123/',
        webContentsId: undefined,
        owners: [owner],
      }),
    ).toEqual({ action: 'pass' })
  })
  it('来源不对（别处的页面借这个窗口连它）：拒', () => {
    expect(
      sceneRequestHeaders({
        url: 'ws://127.0.0.1:5123/',
        webContentsId: 7,
        requestHeaders: { origin: 'https://evil.example' },
        owners: [owner],
      }),
    ).toEqual({ action: 'cancel' })
  })
  it('响应里的 set-cookie 不进页面', () => {
    expect(
      withoutSetCookie({ 'Set-Cookie': ['a=1'], 'content-type': 'text/html', 'x-a': ['b'] }),
    ).toEqual({ 'content-type': ['text/html'], 'x-a': ['b'] })
  })
})

describe('权限：麦克风只给归属窗口主 frame 的音频', () => {
  const p = (patch: Partial<Parameters<typeof decideScenePermission>[0]>) =>
    decideScenePermission({
      permission: 'media',
      owned: true,
      isMainFrame: true,
      requestingUrl: 'http://127.0.0.1:5123/chat',
      sceneOrigin: owner.origin,
      mediaTypes: ['audio'],
      platform: 'darwin',
      ...patch,
    })
  it('macOS 要系统点头；Windows 直接给', () => {
    expect(p({})).toBe('ask-microphone')
    expect(p({ platform: 'win32' })).toBe('allow')
  })
  it('摄像头、子 frame、别的源、别的窗口：不给', () => {
    expect(p({ mediaTypes: ['video'] })).toBe('deny')
    expect(p({ mediaTypes: ['audio', 'video'] })).toBe('deny')
    expect(p({ isMainFrame: false })).toBe('deny')
    expect(p({ requestingUrl: 'https://evil.example/' })).toBe('deny')
    expect(p({ owned: false })).toBe('deny')
  })
  it('别的权限照官方默认给（只限这个场景自己的源）', () => {
    expect(p({ permission: 'clipboard-sanitized-write' })).toBe('allow')
    expect(p({ permission: 'notifications', requestingUrl: 'https://evil.example/' })).toBe('deny')
  })
})

describe('DevTools 快捷键、目录选择的来源、窗口标题', () => {
  const key = (patch: Partial<Parameters<typeof isDevToolsShortcut>[0]>) => ({
    type: 'keyDown',
    key: 'I',
    meta: false,
    control: false,
    alt: false,
    shift: false,
    ...patch,
  })
  it('macOS ⌥⌘I、其他 Ctrl+Shift+I、到处 F12', () => {
    expect(isDevToolsShortcut(key({ meta: true, alt: true }), 'darwin')).toBe(true)
    expect(isDevToolsShortcut(key({ control: true, shift: true }), 'win32')).toBe(true)
    expect(isDevToolsShortcut(key({ key: 'F12' }), 'win32')).toBe(true)
    expect(isDevToolsShortcut(key({ meta: true }), 'darwin')).toBe(false)
    expect(isDevToolsShortcut(key({ key: 'F12', type: 'keyUp' }), 'darwin')).toBe(false)
  })
  it('目录选择只认归属窗口主 frame、在它自己的源上', () => {
    const ok = { webContentsId: 7, isMainFrame: true, frameUrl: 'http://127.0.0.1:5123/x' }
    expect(sceneSender(ok, [owner])).toBe(owner)
    expect(sceneSender({ ...ok, isMainFrame: false }, [owner])).toBeUndefined()
    expect(sceneSender({ ...ok, webContentsId: 1 }, [owner])).toBeUndefined()
    expect(sceneSender({ ...ok, frameUrl: 'https://evil.example/' }, [owner])).toBeUndefined()
  })
  it('标题一眼看出是官方的', () => {
    expect(sceneWindowTitle('web', 'zh-CN')).toBe('DeepSeek Harness（官方）')
    expect(sceneWindowTitle('web', 'en-US')).toBe('DeepSeek Harness (official)')
    expect(sceneWindowTitle('coding', 'zh-CN')).toBe('DeepSeek Harness · coding')
  })
})
