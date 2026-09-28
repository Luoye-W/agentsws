/**
 * 移植自 Luoye/BtoBAgents `tests/unit/btobagents/customer-csv.test.ts`（首次 `7ec5527`，
 * `c832e1e` 改名，仓库 HEAD `940f12b`）。两条原样（字段名改 snake_case、样例邮箱换成
 * `.example` 保留域名），外加本仓多认的几个表头。
 */
import { describe, expect, it } from 'vitest'
import { parseCustomerCsv } from '../src/index.js'

describe('customer CSV parser（移植）', () => {
  it('parses Chinese headers, quoted commas and escaped quotes', () => {
    const rows = parseCustomerCsv(
      '﻿公司,公司域名,联系人,邮箱,职位\r\n"深圳智联, 有限公司",zhilian.example,"王""洛叶",LUOYE@ZHILIAN.EXAMPLE,采购总监\r\n',
    )
    expect(rows).toEqual([
      {
        company: '深圳智联, 有限公司',
        domain: 'zhilian.example',
        contact_name: '王"洛叶',
        email: 'luoye@zhilian.example',
        title: '采购总监',
      },
    ])
  })

  it('requires a company or email column', () => {
    expect(() => parseCustomerCsv('name,phone\nLuoye,123')).toThrow(
      'CSV_COMPANY_OR_EMAIL_COLUMN_REQUIRED',
    )
  })
})

describe('本仓多认的表头', () => {
  it('buyer / 采购商 / whatsapp 都认；网址去掉协议与路径', () => {
    const rows = parseCustomerCsv(
      'Buyer,Website,WhatsApp\nVoltHaus GmbH,https://volthaus.example/contact,+49 000 000\n',
    )
    expect(rows).toEqual([
      { company: 'VoltHaus GmbH', domain: 'volthaus.example', phone: '+49 000 000' },
    ])
  })
  it('只有邮箱没有公司：公司取邮箱域名', () => {
    expect(parseCustomerCsv('邮箱\nbuyer@acme.example\n')).toEqual([
      { company: 'acme.example', email: 'buyer@acme.example' },
    ])
  })
})
