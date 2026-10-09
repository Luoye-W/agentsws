/**
 * WP283（决策 300）：事项里加进来的图上「圈出要改的地方」——拿笔刷涂，涂到的地方改、别处不动。
 *
 * 只在现在的改图型号认遮罩时出现（传图时服务端回 `edit_mask`，按型号能力表判；经 Agents 工坊云的型号
 * 都不认，入口就不给）。出来的是 OpenAI 形态的遮罩：和原图一样大的 PNG，**涂过的地方透明**、别处不透明黑。
 * 遮罩也进品牌素材库（用途标 `mask`），发出去的话里带上它的 id，AI 改图时填进 `mask_asset_id`。
 */
import { Eraser } from 'lucide-react'
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { brandAssetObjectUrl } from '@/lib/api'
import { useApp } from '@/lib/app-context'

type Stroke = { r: number; pts: [number, number][] }

/** 笔刷半径：图短边的 4%（大图小图涂起来手感一样）。 */
const brushOf = (w: number, h: number): number => Math.max(4, Math.round(Math.min(w, h) * 0.04))

function paint(ctx: CanvasRenderingContext2D, strokes: Stroke[], style: string): void {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = style
  for (const s of strokes) {
    const [first, ...rest] = s.pts
    if (first === undefined) continue
    ctx.lineWidth = s.r * 2
    ctx.beginPath()
    ctx.moveTo(first[0], first[1])
    // 只点了一下：画一个点
    if (rest.length === 0) ctx.lineTo(first[0] + 0.01, first[1])
    for (const p of rest) ctx.lineTo(p[0], p[1])
    ctx.stroke()
  }
}

/** 涂过的笔画 → 遮罩 PNG（原图大小；涂过的透明、别处不透明黑）。 */
export async function maskPngOf(
  strokes: Stroke[],
  size: { w: number; h: number },
): Promise<File | undefined> {
  const canvas = document.createElement('canvas')
  canvas.width = size.w
  canvas.height = size.h
  const ctx = canvas.getContext('2d')
  if (ctx === null) return undefined
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.globalCompositeOperation = 'destination-out'
  paint(ctx, strokes, '#000')
  const blob = await new Promise<Blob | null>((ok) => {
    canvas.toBlob(ok, 'image/png')
  })
  return blob === null ? undefined : new File([blob], 'mask.png', { type: 'image/png' })
}

export function MaskDialog({
  src,
  onClose,
  onSave,
  busy = false,
}: {
  /** 那张图的取图地址（`/v1/brand-assets/:id/file`）；`undefined` = 关着。 */
  src: string | undefined
  onClose: () => void
  onSave: (mask: File) => void
  busy?: boolean
}): ReactNode {
  const { t } = useApp()
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [size, setSize] = useState<{ w: number; h: number } | undefined>(undefined)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)

  // 换一张图：重新取字节、清掉上一张的笔画
  useEffect(() => {
    setStrokes([])
    setSize(undefined)
    setUrl(undefined)
    if (src === undefined) return
    let alive = true
    let made: string | undefined
    brandAssetObjectUrl(src)
      .then((u) => {
        made = u
        if (alive) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      if (made !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(made)
    }
  }, [src])

  // 笔画一变就重画（半透明的提示色，盖在图上）
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (ctx === null || ctx === undefined || size === undefined) return
    ctx.clearRect(0, 0, size.w, size.h)
    paint(ctx, strokes, 'rgba(59, 130, 246, 0.5)')
  }, [strokes, size])

  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const box = e.currentTarget.getBoundingClientRect()
    const w = size?.w ?? 1
    const h = size?.h ?? 1
    return [((e.clientX - box.left) / box.width) * w, ((e.clientY - box.top) / box.height) * h]
  }

  return (
    <Dialog open={src !== undefined} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl" data-testid="mask-dialog">
        <DialogHeader>
          <DialogTitle>{t('mask.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-[12.5px] text-ws-muted-fg">{t('mask.hint')}</p>
        <div className="relative mx-auto w-fit max-w-full overflow-hidden rounded-[10px] ring-1 ring-ws-line">
          {url === undefined ? (
            <div className="grid h-48 w-72 place-items-center text-[12.5px] text-ws-muted-fg">
              {t('images.loading')}
            </div>
          ) : (
            <img
              src={url}
              alt=""
              className="block max-h-[60vh] max-w-full select-none"
              draggable={false}
              onLoad={(e) => {
                setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
              }}
            />
          )}
          {size === undefined ? null : (
            <canvas
              ref={canvas}
              width={size.w}
              height={size.h}
              data-testid="mask-canvas"
              className="absolute inset-0 size-full cursor-crosshair touch-none"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId)
                drawing.current = true
                // 坐标先算好：React 的合成事件在更新函数跑之前就把 currentTarget 清掉了
                const p = at(e)
                setStrokes((xs) => [...xs, { r: brushOf(size.w, size.h), pts: [p] }])
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return
                const p = at(e)
                setStrokes((xs) => {
                  const last = xs.at(-1)
                  return last === undefined
                    ? xs
                    : [...xs.slice(0, -1), { ...last, pts: [...last.pts, p] }]
                })
              }}
              onPointerUp={() => {
                drawing.current = false
              }}
              onPointerLeave={() => {
                drawing.current = false
              }}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            disabled={strokes.length === 0}
            onClick={() => {
              setStrokes([])
            }}
          >
            <Eraser aria-hidden className="size-3.5" />
            {t('mask.clear')}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('mask.cancel')}
          </Button>
          <Button
            size="sm"
            data-testid="mask-done"
            disabled={strokes.length === 0 || size === undefined || busy}
            onClick={() => {
              if (size === undefined) return
              void maskPngOf(strokes, size).then((file) => {
                if (file !== undefined) onSave(file)
              })
            }}
          >
            {t('mask.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
