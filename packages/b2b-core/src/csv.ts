/**
 * 客户 CSV 导入与中英文表头别名（docs/84 §6.1「自己的」那一档：展会名单、老客户、旧 CRM 导出）。
 *
 * 出处：Luoye/BtoBAgents（Luoye 自己的私有仓库，本机 `~/Documents/BtoBAgents`）
 * `src/features/btobagents/imports/csv.ts`（首次 `7ec5527`，`c832e1e` 改名），
 * 移植时仓库 HEAD `940f12b`。不在 KOLAgents 纯模板提交 `cb506142` 里。
 *
 * 移植改动：
 * - 字段改成本仓的 snake_case（`contact_name`）；别名表导出成 {@link CUSTOMER_CSV_ALIASES}，
 *   以后并进 `kol-core/import.ts` 那一套时两边读同一张（docs/84 §7）。
 * - 别名多认几个外贸常见的写法（`buyer`、`采购商`、`whatsapp`），原来的一个没删。
 * - 解析器（引号、转义引号、CRLF、BOM、上限 10000 行）与两条错误码原样。
 */
export interface CustomerCsvRow {
  company: string
  domain?: string
  country?: string
  contact_name?: string
  email?: string
  phone?: string
  title?: string
}

function parseRecords(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(field.trim())
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(field.trim())
      field = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else field += character
  }
  row.push(field.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

/** 表头别名（小写比对）。 */
export const CUSTOMER_CSV_ALIASES: Readonly<Record<keyof CustomerCsvRow, readonly string[]>> = {
  company: [
    'company',
    'company name',
    'account',
    'buyer',
    '客户公司',
    '公司',
    '客户名称',
    '采购商',
  ],
  domain: ['domain', 'website', '公司域名', '网站'],
  country: ['country', 'market', '国家', '市场'],
  contact_name: ['contact', 'contact name', 'name', '联系人', '姓名'],
  email: ['email', 'e-mail', '邮箱'],
  phone: ['phone', 'mobile', 'telephone', 'whatsapp', '电话', '手机'],
  title: ['title', 'job title', 'position', '职位', '职务'],
}

export function parseCustomerCsv(text: string): CustomerCsvRow[] {
  const records = parseRecords(text.replace(/^﻿/, ''))
  const headers = records.shift()?.map((value) => value.toLocaleLowerCase())
  if (!headers?.length) throw new Error('CSV_HEADER_REQUIRED')
  const column = (key: keyof CustomerCsvRow) =>
    headers.findIndex((header) => CUSTOMER_CSV_ALIASES[key].includes(header))
  const indexes = Object.fromEntries(
    (Object.keys(CUSTOMER_CSV_ALIASES) as Array<keyof CustomerCsvRow>).map((key) => [
      key,
      column(key),
    ]),
  ) as Record<keyof CustomerCsvRow, number>
  if (indexes.company < 0 && indexes.email < 0)
    throw new Error('CSV_COMPANY_OR_EMAIL_COLUMN_REQUIRED')

  return records.slice(0, 10_000).flatMap((record) => {
    const read = (key: keyof CustomerCsvRow) =>
      indexes[key] >= 0 ? record[indexes[key]]?.trim() : undefined
    const email = read('email')?.toLocaleLowerCase()
    const company = read('company') ?? email?.split('@')[1] ?? ''
    if (!company && !email) return []
    const domain = read('domain')
      ?.replace(/^https?:\/\//, '')
      .split('/')[0]
    const row: CustomerCsvRow = { company }
    // exactOptionalPropertyTypes：没有的格子不写 undefined，干脆不出这个键
    for (const [key, value] of [
      ['domain', domain],
      ['country', read('country')],
      ['contact_name', read('contact_name')],
      ['email', email],
      ['phone', read('phone')],
      ['title', read('title')],
    ] as const)
      if (value !== undefined && value !== '') row[key] = value
    return [row]
  })
}
