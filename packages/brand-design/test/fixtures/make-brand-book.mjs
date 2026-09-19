#!/usr/bin/env node
/**
 * 造那份两页的品牌手册夹具（`brand-book.pdf`）。
 *
 * **为什么是生成的，不是找一份真手册**：真手册是别人的作品，进不了仓库；
 * 而这份夹具要钉住的东西很具体——正文里的 HEX / CMYK / PANTONE、字体名、
 * logo 最小尺寸与留白那两句、以及页面上真正画出来的那几块填充色。
 *
 * 跑法（改了这个脚本才需要跑）：
 *   node packages/brand-design/test/fixtures/make-brand-book.mjs
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const page1 = `
BT /F1 20 Tf 50 780 Td (Heritage Supply Brand Book) Tj ET
BT /F1 12 Tf 50 740 Td (Colors) Tj ET
BT /F1 11 Tf 50 715 Td (Primary  #A8321F   PANTONE 186 C   C0 M100 Y81 K4) Tj ET
BT /F1 11 Tf 50 695 Td (Ink      #1A1C1E) Tj ET
BT /F1 11 Tf 50 675 Td (Limestone #F7F5F2) Tj ET
0.659 0.196 0.122 rg 50 600 120 50 re f
0.102 0.110 0.118 rg 190 600 120 50 re f
0.969 0.961 0.949 rg 330 600 120 50 re f
`.trim()

const page2 = `
BT /F1 20 Tf 50 780 Td (Typography and Logo) Tj ET
BT /F1 11 Tf 50 740 Td (Font Family: Public Sans) Tj ET
BT /F1 11 Tf 50 720 Td (Secondary Typeface: Space Grotesk) Tj ET
BT /F1 12 Tf 50 680 Td (Logo usage) Tj ET
BT /F1 11 Tf 50 655 Td (Minimum width 24 px on screen.) Tj ET
BT /F1 11 Tf 50 635 Td (Clear space: 0.5 x the logo width on every side.) Tj ET
BT /F1 11 Tf 50 615 Td (Never place the logo on a busy photograph.) Tj ET
`.trim()

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  { stream: page1 },
  { stream: page2 },
]

let pdf = '%PDF-1.4\n'
const offsets = []
objects.forEach((obj, i) => {
  offsets.push(pdf.length)
  const n = i + 1
  if (typeof obj === 'string') {
    pdf += `${n} 0 obj\n${obj}\nendobj\n`
  } else {
    pdf += `${n} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream\nendobj\n`
  }
})
const xrefAt = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(join(here, 'brand-book.pdf'), Buffer.from(pdf, 'latin1'))
process.stdout.write(`wrote brand-book.pdf (${pdf.length} bytes)\n`)
