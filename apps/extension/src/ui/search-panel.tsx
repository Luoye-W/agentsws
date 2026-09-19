/**
 * 搜索结果页的批量采集面板（WP119 定论 2：「搜索结果页批量采集（阈值筛选）」）。
 *
 * 这一屏最容易被做成「一键扫全站」。三条把它按住：
 *
 * 1. **候选只来自用户当前这一屏**，而且要按一下「看看这一页有谁」才解析。
 * 2. **过滤掉的与没量到的分开说**。「过滤掉 3 个」不等于「剩下的都达标」——
 *    页面没印那个数字的行是放行的，面板必须单说一句，否则用户会以为
 *    剩下的全都过了自己设的门槛。
 * 3. **分块发、随机间隔、进度看得见**。一次 20 条，某一块失败只赔那 20 行。
 */

import { useCallback, useMemo, useState } from 'react'
import type { BulkCandidate, BulkTally, CaptureFilterPrefs } from '@/lib/bulk'
import {
  applyBulkFailure,
  applyBulkResult,
  applyCaptureFilters,
  BULK_CHUNK_SIZE,
  candidateBestViews,
  candidateSubscribers,
  chunkItems,
  emptyTally,
  parseFilterPrefs,
  randomBatchDelayMs,
} from '@/lib/bulk'
import { formatCount } from '@/lib/counts'
import { send } from '@/lib/messages'
import { parseYouTubeSearch } from '@/lib/parse/youtube'
import { candidateObservation } from '@/lib/to-observation'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function SearchPanel(props: {
  query: string
  pageUrl: string
  onDone: () => void
}): React.ReactNode {
  const [candidates, setCandidates] = useState<BulkCandidate[] | undefined>(undefined)
  const [prefs, setPrefs] = useState<CaptureFilterPrefs>({})
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined)
  const [tally, setTally] = useState<BulkTally | undefined>(undefined)

  const outcome = useMemo(
    () => applyCaptureFilters(candidates ?? [], parseFilterPrefs(prefs)),
    [candidates, prefs],
  )

  // 解析发生在**按下按钮的那一刻**，不是面板打开的那一刻。
  const scan = useCallback(() => {
    setCandidates(parseYouTubeSearch(document, props.pageUrl))
    setTally(undefined)
  }, [props.pageUrl])

  const run = useCallback(() => {
    const rows = outcome.visible
    if (rows.length === 0) return
    const chunks = chunkItems(rows, BULK_CHUNK_SIZE)
    setProgress({ done: 0, total: rows.length })
    void (async () => {
      let acc = emptyTally()
      for (const [index, chunk] of chunks.entries()) {
        // 第一块就是用户那一次点击，不用等；之后每块之间随机等一下。
        if (index > 0) await sleep(randomBatchDelayMs())
        const reply = await send({
          type: 'observe',
          observations: chunk.map((c) =>
            candidateObservation(c, props.pageUrl, new Date().toISOString()),
          ),
        })
        if (reply?.type === 'observe' && reply.outcome.kind === 'saved') {
          acc = applyBulkResult(
            acc,
            Array.from({ length: reply.outcome.saved }, () => ({ status: 'ok' })).concat(
              Array.from({ length: reply.outcome.deduped }, () => ({ status: 'deduped' })),
            ),
            chunk.length,
          )
        } else {
          acc = applyBulkFailure(acc, chunk.length)
        }
        setProgress({
          done: Math.min(rows.length, (index + 1) * BULK_CHUNK_SIZE),
          total: rows.length,
        })
        setTally(acc)
      }
      props.onDone()
    })()
  }, [outcome.visible, props])

  return (
    <>
      <h3 className="ws-name">这一页的搜索结果</h3>
      <p className="ws-handle">{props.query === '' ? '（没读到搜索词）' : props.query}</p>

      {candidates === undefined ? (
        <div className="ws-actions">
          <button type="button" className="ws-btn ws-btn--primary" onClick={scan}>
            看看这一页有谁
          </button>
          <p className="ws-note">
            只看你眼前这一屏。插件不会自己翻页、不会自己滚动，也不会跟着链接走。
          </p>
        </div>
      ) : (
        <>
          <div className="ws-filters">
            <label className="ws-field">
              <span className="ws-label">最低播放</span>
              <input
                className="ws-input"
                placeholder="比如 10万"
                value={prefs.min_views_text ?? ''}
                onChange={(e) => setPrefs((p) => ({ ...p, min_views_text: e.target.value }))}
              />
            </label>
            <label className="ws-field">
              <span className="ws-label">最低订阅</span>
              <input
                className="ws-input"
                placeholder="比如 1万"
                value={prefs.min_subscribers_text ?? ''}
                onChange={(e) => setPrefs((p) => ({ ...p, min_subscribers_text: e.target.value }))}
              />
            </label>
          </div>

          <ul className="ws-list" data-testid="ws-candidates">
            {outcome.visible.map((c) => (
              <li className="ws-row" key={c.external_id}>
                <div className="ws-row-main">
                  <div className="ws-row-name">{c.display_name ?? c.external_id}</div>
                  <div className="ws-row-meta">
                    订阅 {formatCount(candidateSubscribers(c))} · 最高播放{' '}
                    {formatCount(candidateBestViews(c))}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <p className="ws-destination" data-testid="ws-filter-note">
            这一页有 {candidates.length} 个人
            {outcome.hidden > 0 ? `，按你的门槛滤掉了 ${outcome.hidden} 个` : ''}
            {outcome.unknown > 0
              ? `。剩下的里面有 ${outcome.unknown} 个页面上没印这个数字——没量到的一律留着，不是他们达标了`
              : ''}
            。
          </p>

          <div className="ws-actions">
            <button
              type="button"
              className="ws-btn ws-btn--primary"
              onClick={run}
              disabled={progress !== undefined && progress.done < progress.total}
            >
              {progress === undefined
                ? `把这 ${outcome.visible.length} 个收进红人库`
                : `${progress.done} / ${progress.total}`}
            </button>
            <button type="button" className="ws-btn ws-btn--ghost" onClick={scan}>
              重新看一遍这一页
            </button>
          </div>

          {tally === undefined ? null : (
            <p className="ws-note" data-testid="ws-tally">
              收进去 {tally.ok} 个，本来就有 {tally.deduped} 个
              {tally.invalid > 0 ? `，没认出来 ${tally.invalid} 个` : ''}
              {tally.failed > 0 ? `，没发出去 ${tally.failed} 个（会排队补传）` : ''}。
            </p>
          )}
        </>
      )}
    </>
  )
}
