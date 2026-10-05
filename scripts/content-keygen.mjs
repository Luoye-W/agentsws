#!/usr/bin/env node
/**
 * WP219（docs/90 §4.2）：生成内容包的 ed25519 签名钥匙对——**Luoye 本人在自己电脑上跑一次**。
 *
 * ```
 * node scripts/content-keygen.mjs --out ~/agentsws-content-signing.pem
 * gh secret set CONTENT_SIGNING_KEY < ~/agentsws-content-signing.pem   # 私钥进 GitHub secret
 * # 然后把打印出来的公钥那一行填进 packages/contracts/src/content-updates.ts 的 CONTENT_SIGNING_PUBLIC_KEYS
 * # 私钥文件：放进密码管理器或离线备份后删掉
 * ```
 *
 * - 私钥只写到 `--out` 指定的文件（权限 600），**不打印、不进仓库**：`--out` 落在仓库里直接拒；文件已存在也拒（不覆盖）；
 * - 屏幕上只打印公钥（`key_id` + base64），那是要公开的东西。
 */
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSkills, REPO_ROOT } from './content-pack-lib.mjs'

export async function run(argv = process.argv.slice(2), root = REPO_ROOT) {
  const i = argv.indexOf('--out')
  const raw = i >= 0 ? argv[i + 1] : undefined
  if (raw === undefined) throw new Error('要给 --out <仓库外的路径>（私钥只写到那里）')
  const out = resolve(raw.replace(/^~(?=\/)/, homedir()))
  const rel = relative(resolve(root), out)
  if (!rel.startsWith('..') && !rel.startsWith('/'))
    throw new Error('私钥不许写进仓库目录，换一个仓库外的路径')
  if (existsSync(out)) throw new Error(`${out} 已经有了，不覆盖`)
  const skills = await loadSkills()
  const pem = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
  writeFileSync(out, pem, { mode: 0o600 })
  const pub = skills.contentPublicKeyOf(pem)
  process.stdout.write(
    [
      `私钥已写到 ${out}（权限 600）。`,
      '下一步：',
      `  gh secret set CONTENT_SIGNING_KEY < ${out}`,
      '  把下面这一行加进 packages/contracts/src/content-updates.ts 的 CONTENT_SIGNING_PUBLIC_KEYS：',
      `  { key_id: '${pub.key_id}', public_key: '${pub.public_key}' },`,
      '  私钥文件进密码管理器 / 离线备份之后删掉。',
      '',
    ].join('\n'),
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    },
  )
}
