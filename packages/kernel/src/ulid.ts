/**
 * ULID（21 §1「id 为 ULID，时间有序」）。自实现，不引依赖；时间与随机全部注入，
 * 同一毫秒内单调递增（随机段 +1），保证 `since` 按 id 续传严格有序。
 */
import type { Clock, Random } from './clock.js'
import { KernelError } from './errors.js'

/** Crockford Base32（去掉 I L O U）。 */
const ENCODING = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ']
const RADIX = ENCODING.length
const TIME_LEN = 10
const RANDOM_LEN = 16
export const ULID_LEN = TIME_LEN + RANDOM_LEN
const MAX_TIME = 0xffffffffffff

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** 是否是形状合法的 ULID。 */
export function isUlid(value: string): boolean {
  return ULID_RE.test(value)
}

function symbol(index: number): string {
  const c = ENCODING[index]
  if (c === undefined) throw new KernelError('invalid_input', `ulid symbol out of range: ${index}`)
  return c
}

function encodeTime(time: number): string {
  if (!Number.isInteger(time) || time < 0 || time > MAX_TIME) {
    throw new KernelError('invalid_input', `ulid timestamp out of range: ${time}`)
  }
  let rest = time
  let out = ''
  for (let i = 0; i < TIME_LEN; i++) {
    out = symbol(rest % RADIX) + out
    rest = Math.floor(rest / RADIX)
  }
  return out
}

function randomDigits(random: Random): number[] {
  const digits: number[] = []
  for (let i = 0; i < RANDOM_LEN; i++) {
    const r = random()
    if (!(r >= 0 && r < 1)) {
      throw new KernelError('invalid_input', `random source must return [0, 1), got ${r}`)
    }
    digits.push(Math.floor(r * RADIX))
  }
  return digits
}

function increment(digits: number[]): void {
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i] ?? 0
    if (d < RADIX - 1) {
      digits[i] = d + 1
      return
    }
    digits[i] = 0
  }
  throw new KernelError('conflict', 'ulid randomness exhausted within a single millisecond')
}

/**
 * 造一个 ULID 生成器。同毫秒内单调递增；时间倒流（合成时钟回拨）时同样保持单调，
 * 沿用上一毫秒并继续递增，避免 id 序倒置破坏 `since` 续传。
 */
export function createUlidFactory(clock: Clock, random: Random): () => string {
  let lastTime = -1
  let lastDigits: number[] = []
  return () => {
    const now = Date.parse(clock.now())
    if (!Number.isFinite(now)) {
      throw new KernelError('invalid_input', `clock.now() is not a valid ISO-8601 instant`)
    }
    if (now > lastTime) {
      lastTime = now
      lastDigits = randomDigits(random)
    } else {
      increment(lastDigits)
    }
    return encodeTime(lastTime) + lastDigits.map(symbol).join('')
  }
}
