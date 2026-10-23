/** 移植自 agentsws-extension `src/contents/utils/mediaProbe.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/contents/utils/mediaProbe.ts` @ d25b877。 */
/**
 * What a piece of content physically IS: how long it runs, and which way up.
 *
 * Both facts are decided by the platform's editor, not by us, and both change
 * what a video is worth: a 45-second portrait clip and a 20-minute landscape
 * review are different products at different rates, and a brand briefing for
 * one is wrong for the other. Neither was captured, so every content row
 * looked the same shape downstream.
 *
 * The rule throughout is MEASURE, never assume. "TikTok is portrait" and
 * "YouTube is landscape" are true often enough to be dangerous: TikTok hosts
 * landscape uploads, YouTube hosts Shorts, and a guessed orientation is
 * indistinguishable from a measured one once it is in the database. So an
 * unmeasurable player reports null and the row simply says nothing.
 */

export type MediaOrientation = "landscape" | "portrait"

export type MediaMeasurement = {
  orientation: MediaOrientation | null
  /** Whole seconds. Null for stills, live streams and unloaded players. */
  durationSeconds: number | null
}

/** The honest answer when there was nothing to measure. */
export const UNMEASURED: MediaMeasurement = {
  orientation: null,
  durationSeconds: null
}

/**
 * The whole judgement, as arithmetic — no DOM, so it is testable.
 *
 * A square is neither landscape nor portrait, so it reports null rather than
 * being rounded into whichever bucket `>` happens to favour; Instagram's
 * 1:1 posts are common enough that the wrong answer would be a whole column
 * of quiet lies.
 *
 * Duration has three non-answers that all arrive as numbers: NaN before the
 * player has metadata, 0 as the pre-playback placeholder documented on the
 * YouTube scraper, and Infinity on a live stream. None of those is a length.
 */
export function measureMedia(input: {
  width?: number | null
  height?: number | null
  duration?: number | null
}): MediaMeasurement {
  const { width, height, duration } = input

  const sized =
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0

  const orientation: MediaOrientation | null = !sized
    ? null
    : width === height
      ? null
      : (height as number) > (width as number)
        ? "portrait"
        : "landscape"

  const rounded =
    typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? Math.round(duration)
      : 0

  return { orientation, durationSeconds: rounded > 0 ? rounded : null }
}

export function measureVideoElement(
  video: HTMLVideoElement | null | undefined
): MediaMeasurement {
  if (!video) return UNMEASURED
  return measureMedia({
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration
  })
}

/** Stills carry an orientation and no duration. */
export function measureImageElement(
  image: HTMLImageElement | null | undefined
): MediaMeasurement {
  if (!image) return UNMEASURED
  return measureMedia({
    width: image.naturalWidth,
    height: image.naturalHeight
  })
}

/**
 * The video the user is actually looking at.
 *
 * `document.querySelector("video")` is regularly the wrong one: a TikTok
 * profile keeps muted grid previews mounted behind the video overlay, and
 * Instagram mounts the next reel before you scroll to it. The one filling the
 * screen is the one being watched, so pick by rendered area — falling back to
 * any element that has decoded frames when nothing has been laid out yet.
 */
export function primaryVideoElement(
  root: ParentNode = document
): HTMLVideoElement | null {
  const videos = Array.from(root.querySelectorAll<HTMLVideoElement>("video"))
  let best: HTMLVideoElement | null = null
  let bestArea = 0

  for (const video of videos) {
    const area = video.clientWidth * video.clientHeight
    if (area > bestArea) {
      bestArea = area
      best = video
    }
  }

  if (best) return best
  return videos.find((video) => video.videoWidth > 0) ?? null
}

/**
 * The largest decoded image under `root`, for photo posts. `minWidth` is what
 * keeps avatars, reaction glyphs and suggested-account thumbnails out of the
 * answer — they are images too, and they are never the post.
 */
export function largestImageElement(
  root: ParentNode = document,
  minWidth = 320
): HTMLImageElement | null {
  let best: HTMLImageElement | null = null
  let bestArea = 0

  for (const image of Array.from(
    root.querySelectorAll<HTMLImageElement>("img")
  )) {
    if (image.naturalWidth < minWidth) continue
    const area = image.naturalWidth * image.naturalHeight
    if (area <= bestArea) continue
    bestArea = area
    best = image
  }

  return best
}
