/** class 合并：与工作台同一个语义（后一个 Tailwind class 覆盖前一个）。 */
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))
