/** WP218：打包入口只加更新源覆盖与 `--publish never`，别的参数原样交给 electron-builder。 */
import { describe, expect, it } from 'vitest'
import { distArgs } from '../scripts/dist.mjs'

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
