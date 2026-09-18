/**
 * WP97：把一个 `Blob` 读成字节。
 *
 * 一句 `blob.arrayBuffer()` 就够了——**在真浏览器里**。测试跑在 jsdom 上，
 * 而 jsdom 25 的 `Blob` 到现在还没有这个方法（JSZip 不受影响是因为它走的是
 * `FileReader`）。所以这里兜一层：有 `arrayBuffer` 用它，没有就退回 `FileReader`。
 *
 * 写成一个共用函数而不是在表格那一档里就地兜：下一个读 Blob 的视图不该再踩一遍。
 */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  const direct = (blob as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer
  if (typeof direct === 'function') return new Uint8Array(await direct.call(blob))
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('读不出这个文件的字节'))
    }
    reader.readAsArrayBuffer(blob)
  })
}
