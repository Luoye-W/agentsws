import { describe, expect, it } from 'vitest'
import {
  builderArgs,
  channelOf,
  channelUrl,
  DEFAULT_FEED_BASE,
  feedFromEnv,
  githubFallbackEnabled,
  githubFallbackFeed,
  normalizeBaseUrl,
  parseAppUpdateYml,
  updateInfoFile,
  versionFromUpdateInfo,
} from '../src/update-feed.js'

describe('渠道', () => {
  it('带预发布段的是 beta，正式版是 stable', () => {
    expect(channelOf('0.2.0-beta.3')).toBe('beta')
    expect(channelOf('v0.2.0')).toBe('stable')
    expect(channelOf('1.0.0-rc.1')).toBe('beta')
  })
})

describe('构建时选源', () => {
  it('默认 = 自有下载站，渠道目录按版本号', () => {
    expect(feedFromEnv({}, '0.2.0-beta.1')).toEqual({
      provider: 'generic',
      url: `${DEFAULT_FEED_BASE}/beta`,
      channel: 'beta',
    })
    expect(feedFromEnv({}, '0.2.0')).toMatchObject({ url: `${DEFAULT_FEED_BASE}/stable` })
  })

  it('变量能换根地址、强制渠道', () => {
    expect(
      feedFromEnv(
        {
          AGENTSWS_UPDATE_PROVIDER: 'generic',
          AGENTSWS_UPDATE_BASE_URL: 'https://downloads.example.com/agentsws/',
          AGENTSWS_UPDATE_CHANNEL: 'stable',
        },
        '0.2.0-beta.1',
      ),
    ).toEqual({
      provider: 'generic',
      url: 'https://downloads.example.com/agentsws/stable',
      channel: 'stable',
    })
    expect(
      feedFromEnv({ AGENTSWS_UPDATE_PROVIDER: '', AGENTSWS_UPDATE_BASE_URL: '' }, '1.0.0'),
    ).toMatchObject({ url: `${DEFAULT_FEED_BASE}/stable` })
  })

  it('选 GitHub', () => {
    expect(feedFromEnv({ AGENTSWS_UPDATE_PROVIDER: 'github' }, '0.2.0-beta.1')).toEqual({
      provider: 'github',
      owner: 'Luoye-W',
      repo: 'agentsws',
      channel: 'beta',
    })
  })

  it('写错就打包失败', () => {
    expect(() => feedFromEnv({ AGENTSWS_UPDATE_PROVIDER: 's3' }, '1.0.0')).toThrow(/generic/)
    expect(() => feedFromEnv({ AGENTSWS_UPDATE_CHANNEL: 'nightly' }, '1.0.0')).toThrow(/stable/)
    expect(() => feedFromEnv({ AGENTSWS_UPDATE_BASE_URL: 'http://dl.x.com' }, '1.0.0')).toThrow(
      /https/,
    )
  })

  it('electron-builder 覆盖参数', () => {
    expect(builderArgs(feedFromEnv({}, '0.2.0-beta.1'))).toEqual([
      '-c.detectUpdateChannel=false',
      '-c.publish.provider=generic',
      `-c.publish.url=${DEFAULT_FEED_BASE}/beta`,
    ])
    expect(builderArgs(feedFromEnv({ AGENTSWS_UPDATE_PROVIDER: 'github' }, '0.2.0'))).toEqual([
      '-c.detectUpdateChannel=false',
      '-c.publish.provider=github',
      '-c.publish.owner=Luoye-W',
      '-c.publish.repo=agentsws',
      '-c.publish.releaseType=release',
    ])
    expect(
      builderArgs(feedFromEnv({ AGENTSWS_UPDATE_PROVIDER: 'github' }, '0.2.0-beta.1')),
    ).toContain('-c.publish.releaseType=prerelease')
  })
})

describe('地址', () => {
  it('规范化', () => {
    expect(normalizeBaseUrl('https://dl.agentsws.com/')).toBe('https://dl.agentsws.com')
    expect(channelUrl('https://dl.agentsws.com//', 'beta')).toBe('https://dl.agentsws.com/beta')
    expect(() => normalizeBaseUrl('not a url')).toThrow(/合法/)
    expect(() => normalizeBaseUrl('https://dl.agentsws.com/?x=1')).toThrow(/\?/)
  })

  it('WP225：本机回环上的 http 放行（CI 端到端的本地更新源），别的 http 照样不认', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:47613/')).toBe('http://127.0.0.1:47613')
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeBaseUrl('http://[::1]:9/x')).toBe('http://[::1]:9/x')
    expect(() => normalizeBaseUrl('http://127.0.0.1.evil.com')).toThrow(/https/)
    expect(() => normalizeBaseUrl('http://10.0.0.1')).toThrow(/https/)
    expect(() => normalizeBaseUrl('ftp://127.0.0.1')).toThrow(/https/)
    expect(channelUrl('http://127.0.0.1:47613', 'beta')).toBe('http://127.0.0.1:47613/beta')
  })
})

describe('运行时读 app-update.yml', () => {
  it('generic', () => {
    const yml = 'provider: generic\nurl: https://dl.agentsws.com/beta\nupdaterCacheDirName: x\n'
    expect(parseAppUpdateYml(yml, '0.2.0-beta.1')).toEqual({
      provider: 'generic',
      url: 'https://dl.agentsws.com/beta',
      channel: 'beta',
    })
  })

  it('github（带引号、CRLF）', () => {
    const yml = "owner: 'Luoye-W'\r\nrepo: agentsws\r\nprovider: github\r\n"
    expect(parseAppUpdateYml(yml, '1.0.0')).toEqual({
      provider: 'github',
      owner: 'Luoye-W',
      repo: 'agentsws',
      channel: 'stable',
    })
  })

  it('读不懂就 undefined', () => {
    expect(parseAppUpdateYml('provider: generic\n', '1.0.0')).toBeUndefined()
    expect(parseAppUpdateYml('provider: generic\nurl: http://x\n', '1.0.0')).toBeUndefined()
    expect(parseAppUpdateYml('provider: github\nowner: x\n', '1.0.0')).toBeUndefined()
    expect(parseAppUpdateYml('provider: s3\n', '1.0.0')).toBeUndefined()
    expect(parseAppUpdateYml('', '1.0.0')).toBeUndefined()
  })
})

describe('GitHub 备用', () => {
  it('开关：环境变量 > config.json > 默认开', () => {
    expect(githubFallbackEnabled({}, undefined)).toBe(true)
    expect(githubFallbackEnabled({}, false)).toBe(false)
    expect(githubFallbackEnabled({ AGENTSWS_UPDATE_GITHUB_FALLBACK: '0' }, true)).toBe(false)
    expect(githubFallbackEnabled({ AGENTSWS_UPDATE_GITHUB_FALLBACK: '1' }, false)).toBe(true)
  })

  it('主源是 generic 才有备用；同渠道', () => {
    expect(
      githubFallbackFeed({
        provider: 'generic',
        url: 'https://dl.agentsws.com/beta',
        channel: 'beta',
      }),
    ).toEqual({ provider: 'github', owner: 'Luoye-W', repo: 'agentsws', channel: 'beta' })
    expect(
      githubFallbackFeed({ provider: 'github', owner: 'a', repo: 'b', channel: 'stable' }),
    ).toBeUndefined()
  })
})

describe('版本信息文件', () => {
  it('按平台', () => {
    expect(updateInfoFile('win32')).toBe('latest.yml')
    expect(updateInfoFile('darwin')).toBe('latest-mac.yml')
    expect(updateInfoFile('linux')).toBe('latest-linux.yml')
  })

  it('取 version', () => {
    expect(versionFromUpdateInfo('version: 0.2.0-beta.2\nfiles:\n  - url: a.dmg\n')).toBe(
      '0.2.0-beta.2',
    )
    expect(versionFromUpdateInfo("version: '1.0.0'\n")).toBe('1.0.0')
    expect(versionFromUpdateInfo('files: []\n')).toBeUndefined()
  })
})
