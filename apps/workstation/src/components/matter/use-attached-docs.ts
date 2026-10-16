/**
 * WP357：岗位页与事项 / 线程输入框「附资料」那一格的状态（与助理输入框同一套规矩）。
 *
 * - 只收 `isDocFile` 认的六种、每份 ≤ 5 MB、一次最多 3 份；超了的不收，`problem` 说一句；
 * - 读成 base64 留在本页（`readDoc`），发出去时调用方带上 `files`；读文字、截断、抹口令都在服务端
 *   （与助理那条路同一份 `readAssistantFile`）。
 */
import { useState } from 'react'
import {
  DOC_MAX_BYTES,
  DOC_MAX_COUNT,
  type FreeChatFile,
  isDocFile,
  readDoc,
} from '@/lib/free-chat'

export function useAttachedDocs(): {
  docs: FreeChatFile[]
  problem: boolean
  add(files: File[]): void
  remove(index: number): void
  /** 发出去了：清空，回清掉之前那几份（没发成时 `restore`）。 */
  take(): FreeChatFile[]
  restore(files: FreeChatFile[]): void
} {
  const [docs, setDocs] = useState<FreeChatFile[]>([])
  const [problem, setProblem] = useState(false)
  return {
    docs,
    problem,
    add(files) {
      const ok = files.filter((f) => isDocFile(f.name) && f.size <= DOC_MAX_BYTES)
      setProblem(ok.length < files.length)
      void Promise.all(ok.map((f) => readDoc(f)))
        .then((read) => {
          setDocs((prev) => [...prev, ...read].slice(0, DOC_MAX_COUNT))
        })
        .catch(() => {
          setProblem(true)
        })
    },
    remove(index) {
      setDocs((prev) => prev.filter((_d, i) => i !== index))
    },
    take() {
      const now = docs
      setDocs([])
      setProblem(false)
      return now
    },
    restore(files) {
      if (files.length > 0) setDocs((prev) => [...files, ...prev].slice(0, DOC_MAX_COUNT))
    },
  }
}
