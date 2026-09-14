/**
 * 内存里的 zip 读写（只为知识包的导入 / 导出）。
 *
 * 为什么自己写：`apps/server/src/backup.ts` 那一份是**按目录**打包的平结构，
 * 知识包要的是**按内存里的一组 `路径 → 正文`** 打包、而且路径带一层目录
 * （`02-features/webhooks.md`）。为一个 200 行的编解码拉一个依赖不划算——
 * 这里只支持 store 与 deflate 两种方法，够读浏览器与 macOS 打出来的包。
 *
 * 安全：解包时**绝对路径、`..`、盘符一律拒**。一个导入端因为路径穿越把文件写到
 * 仓库外面去，是这类功能最典型的出事方式。
 */
import { Buffer } from 'node:buffer'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { invalidInput } from './errors.js'

export interface ZipFile {
  path: string
  content: string
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 打包。路径原样写进去（含目录分隔符）。 */
export function zipFiles(files: readonly ZipFile[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let centralSize = 0
  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8')
    const deflated = deflateRawSync(data)
    const useDeflate = deflated.length < data.length
    const compressed = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)
    const nameBuf = Buffer.from(file.path, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, compressed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compressed.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    centralSize += cd.length + nameBuf.length
    offset += local.length + nameBuf.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, ...central, end])
}

/** 包里的路径要不要收下：绝对路径、`..`、盘符一律拒；目录项（以 `/` 结尾）跳过。 */
export function safeZipPath(name: string): string | undefined {
  const path = name.replace(/\\/g, '/')
  if (path === '' || path.endsWith('/')) return undefined
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) throw invalidInput(`包里有绝对路径：${name}`)
  if (path.split('/').includes('..')) throw invalidInput(`包里有路径穿越：${name}`)
  // macOS 打包留下的元数据目录，静默跳过
  if (path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') return undefined
  return path
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw invalidInput('不是一个 zip 包（找不到中央目录结尾）')
}

export function unzipFiles(buf: Buffer): ZipFile[] {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  let cursor = buf.readUInt32LE(eocd + 16)
  const out: ZipFile[] = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) throw invalidInput('zip 中央目录坏了')
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen
    const path = safeZipPath(name)
    if (path === undefined) continue
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (crc32(data) !== crc) throw invalidInput(`${path} 的 CRC 对不上`)
    out.push({ path, content: data.toString('utf8') })
  }
  return out
}
