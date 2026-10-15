/** WP218：打包入口只加更新源覆盖与 `--publish never`，别的参数原样交给 electron-builder。 */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distArgs, extensionBuild } from '../scripts/dist.mjs'

describe('scripts/dist.mjs distArgs', () => {
  it('原样转交 + 更新源 + 永不上传', () => {
    expect(distArgs(['-c.publish.provider=generic'], ['--win', '--x64'])).toEqual([
      '--win',
      '--x64',
      '-c.publish.provider=generic',
      '--publish',
      'never',
    ])
  })

  it('调用方给的 --publish 一律压掉（上传只由 release.yml 做）', () => {
    expect(
      distArgs([], ['--mac', '--publish', 'always', '-p', 'onTag', '--publish=always']),
    ).toEqual(['--mac', '--publish', 'never'])
  })
})

describe('WP345：打包前按这一包的版本号构建插件', () => {
  it('node 直接跑 wxt build，版本经 AGENTSWS_EXTENSION_VERSION 给', () => {
    const out = extensionBuild('/repo', '0.2.0-beta.8', { PATH: '/bin' })
    expect(out.command).toBe(process.execPath)
    expect(out.args).toEqual([
      join('/repo', 'apps', 'extension', 'node_modules', 'wxt', 'bin', 'wxt.mjs'),
      'build',
    ])
    expect(out.cwd).toBe(join('/repo', 'apps', 'extension'))
    expect(out.env).toEqual({ PATH: '/bin', AGENTSWS_EXTENSION_VERSION: '0.2.0-beta.8' })
  })
})
