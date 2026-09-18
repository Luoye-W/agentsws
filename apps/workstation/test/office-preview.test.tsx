/**
 * WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：**第三栏的 Office 预览**。
 *
 * 钉住的七件事：
 *
 * 1. `canOpen` 只认那五种扩展名——别的交给下载，不开一个空抽屉；
 * 2. 它是 `resolvePanel()` 的**第一个真入口**：一个文件地址排到它这儿；
 * 3. 三种格式各渲染出预期的字（样本是 `office-fixtures.ts` 现造的，不是下载来的）；
 * 4. 大表按 200 行分页、多 sheet 切得动；
 * 5. 超限（≥ 20 MB）与读坏了都**降级成"下载查看"**，不卡住也不空白；
 * 6. 同一份文件再点一次 = 聚焦已经开着的那个，不开第二个、也不重挂；
 * 7. 两条边界：渲染树里没有 inline script、没有外链；文件内容不落 localStorage。
 */
import { fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import {
  canOpenOfficeFile,
  fileAddress,
  officeKindOf,
  parseFileAddress,
} from '@/components/rail/panels/office/address'
import { RenderTimeoutError, withDeadline } from '@/components/rail/panels/office/deadline'
import { resolveRelTarget } from '@/components/rail/panels/office/slides-view'
import { RailStateProvider, useRailState } from '@/components/rail/rail-state'
import { resolvePanel } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import type { KnowledgeSource, SourceFileResult } from '@/lib/api'
import { renderWithProviders } from './helpers'
import { bigXlsxFixture, docxFixture, pptxFixture, xlsxFixture } from './office-fixtures'

const SOURCES: KnowledgeSource[] = [
  {
    id: 'src_1',
    workspace_id: 'ws_1',
    kind: 'upload',
    ref: 'uploads/报价单.xlsx',
    acl_inherit: false,
    chunks: 1,
    parser: 'anydoc',
  },
  {
    id: 'src_2',
    workspace_id: 'ws_1',
    kind: 'upload',
    ref: 'uploads/退货说明.docx',
    acl_inherit: false,
    chunks: 1,
    parser: 'anydoc',
  },
]

const listKnowledgeSources = vi.fn(async () => SOURCES)
const getKnowledgeSourceFile = vi.fn<() => Promise<SourceFileResult>>()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listKnowledgeSources: () => listKnowledgeSources(),
    getKnowledgeSourceFile: (...a: unknown[]) => getKnowledgeSourceFile(...(a as [])),
  }
})

const { OfficePreviewPanel } = await import('@/components/rail/panels/office-preview-panel')

function result(filename: string, blob: Blob): SourceFileResult {
  return {
    filename,
    size: blob.size,
    content_type: 'application/octet-stream',
    too_large: false,
    blob,
  }
}

function renderPanel(filename: string): void {
  renderWithProviders(
    <OfficePreviewPanel
      tier="position"
      pathname="/knowledge"
      address={fileAddress('src_1', filename)}
    />,
  )
}

describe('地址与 canOpen（#3 排序的一票否决那一格）', () => {
  it('五种扩展名认，别的不认', () => {
    for (const name of ['a.docx', 'a.xlsx', 'a.xls', 'a.csv', 'a.pptx', 'A.DOCX'])
      expect(canOpenOfficeFile({ address: fileAddress('src_1', name) })).toBe(true)
    for (const name of ['a.pdf', 'a.zip', 'a.doc', 'a.ppt', 'a.md', 'a'])
      expect(canOpenOfficeFile({ address: fileAddress('src_1', name) })).toBe(false)
  })

  it('地址里没有文件名 = 判不出来 = 不接（让调用方去下载）', () => {
    expect(canOpenOfficeFile({ address: 'agentsws://file/src_1' })).toBe(false)
    expect(canOpenOfficeFile({ address: 'agentsws://matter/mat_1' })).toBe(false)
    expect(canOpenOfficeFile({})).toBe(false)
  })

  it('中文名与空格来回一趟不变形', () => {
    const address = fileAddress('src_1', '2026 报价 单.xlsx')
    expect(parseFileAddress(address)).toEqual({
      source_id: 'src_1',
      filename: '2026 报价 单.xlsx',
    })
    expect(officeKindOf('2026 报价 单.xlsx')).toBe('sheet')
  })

  it('一个文件地址排到这个面板身上——注册表的第一个真入口', () => {
    ensureBuiltinPanels()
    expect(resolvePanel({ address: fileAddress('src_1', '报价单.xlsx') })?.id).toBe(
      'office-preview',
    )
    // 同一条 pattern 命中、但 `canOpen` 否决 → 没有第二个面板顶上，回 undefined
    expect(resolvePanel({ address: fileAddress('src_1', '合同.pdf') })).toBeUndefined()
  })
})

describe('三种格式各渲染出预期的字', () => {
  it('Excel：表格画出来，多 sheet 切得动', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('报价单.xlsx', await xlsxFixture()))
    renderPanel('报价单.xlsx')
    const sheet = await screen.findByTestId('rail-office-sheet', undefined, { timeout: 5000 })
    expect(sheet.getAttribute('data-sheets')).toBe('2')
    expect(sheet.textContent).toContain('订单号')
    expect(sheet.textContent).toContain('SO-2')
    fireEvent.click(screen.getByTestId('rail-office-sheet-tab-退款'))
    expect(screen.getByTestId('rail-office-sheet').textContent).toContain('尺码不合')
  })

  it('Excel：一页 200 行，翻页看得见第 201 行', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('大表.xlsx', await bigXlsxFixture(240)))
    renderPanel('大表.xlsx')
    const sheet = await screen.findByTestId('rail-office-sheet', undefined, { timeout: 5000 })
    // 表头 + 240 行 = 241
    expect(screen.getByTestId('rail-office-sheet-rows').textContent).toContain('241')
    expect(sheet.textContent).toContain('第199行')
    expect(sheet.textContent).not.toContain('第240行')
    expect(screen.getByTestId('rail-office-page').textContent).toContain('1')
    fireEvent.click(screen.getByTestId('rail-office-page-next'))
    expect(screen.getByTestId('rail-office-sheet').textContent).toContain('第240行')
  })

  it('Word：段落文字出来了', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('退货说明.docx', await docxFixture()))
    renderPanel('退货说明.docx')
    const body = await screen.findByTestId('rail-office-word-body')
    await vi.waitFor(() => {
      expect(body.textContent).toContain('退货窗口是 30 天')
    })
    expect(body.textContent).toContain('超过 30 天走人工审批')
  })

  it('PPT：基础版——每页文字 + 翻页，而且把"基础版"说出来', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('方案.pptx', await pptxFixture()))
    renderPanel('方案.pptx')
    const slides = await screen.findByTestId('rail-office-slides', undefined, { timeout: 5000 })
    expect(slides.getAttribute('data-slides')).toBe('2')
    expect(screen.getByTestId('rail-office-slides-basic')).toBeDefined()
    expect(screen.getByTestId('rail-office-slide-1').textContent).toContain('第一页正文')
    fireEvent.click(screen.getByTestId('rail-office-page-next'))
    expect(screen.getByTestId('rail-office-slide-2').textContent).toContain('第二页标题')
  })

  it('pptx 的关系路径按 `ppt/slides/` 解，不出网', () => {
    expect(resolveRelTarget('../media/image1.png')).toBe('ppt/media/image1.png')
    expect(resolveRelTarget('media/x.png')).toBe('ppt/slides/media/x.png')
    expect(resolveRelTarget('https://example.com/a.png')).toBeUndefined()
  })
})

describe('画不出来的时候照实说，并给"下载查看"', () => {
  it('超过 20 MB：不渲染，只给下载', async () => {
    getKnowledgeSourceFile.mockResolvedValue({
      filename: '年度明细.xlsx',
      size: 21 * 1024 * 1024,
      content_type: 'application/octet-stream',
      too_large: true,
    })
    renderPanel('年度明细.xlsx')
    expect(await screen.findByTestId('rail-office-too-large')).toBeDefined()
    expect(screen.queryByTestId('rail-office-sheet')).toBeNull()
    expect(screen.getByTestId('rail-office-download')).toBeDefined()
    expect(screen.getByTestId('rail-office-meta').textContent).toContain('21.0 MB')
  })

  it('文件读不开：说一句，并把头上那句换成"下载查看"', async () => {
    // 半个 zip：JSZip 在 `loadAsync` 就抛，走的正是"读不开"那一支
    getKnowledgeSourceFile.mockResolvedValue(
      result('坏的.docx', new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9])])),
    )
    renderPanel('坏的.docx')
    expect(
      await screen.findByTestId('rail-office-broken', undefined, { timeout: 5000 }),
    ).toBeDefined()
    expect(screen.getByTestId('rail-office-fallback')).toBeDefined()
  })

  it('不是 Office 文件的字节（xlsx 名字、四个随机字节）：不崩，下载按钮照样在', async () => {
    // SheetJS 会把认不出的字节当一行纯文本读进来，于是这里既不抛也不空白。
    // 钉的是"不崩"：一个外来文件把第三栏整栏炸掉，比画得难看严重得多
    getKnowledgeSourceFile.mockResolvedValue(
      result('坏的.xlsx', new Blob([new Uint8Array([1, 2, 3, 4])])),
    )
    renderPanel('坏的.xlsx')
    await screen.findByTestId('rail-office-sheet', undefined, { timeout: 5000 })
    expect(screen.getByTestId('rail-office-download')).toBeDefined()
  })

  it('五秒画不完就不等了（`withDeadline` 本身）', async () => {
    vi.useFakeTimers()
    const never = new Promise<string>(() => {})
    const raced = withDeadline(never, 5_000)
    const caught = raced.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await caught).toBeInstanceOf(RenderTimeoutError)
    vi.useRealTimers()
  })

  it('没给地址（人点图标轨开的）：照实说去知识库点一份', () => {
    renderWithProviders(<OfficePreviewPanel tier="position" pathname="/knowledge" />)
    expect(screen.getByTestId('rail-office-no-file')).toBeDefined()
    expect(getKnowledgeSourceFile).not.toHaveBeenCalled()
  })
})

/** 一个只管按钮的壳：把 `openAddress` 暴露成一个可点的东西。 */
function OpenTwice({ address }: { address: string }): ReactNode {
  const rail = useRailState()
  return (
    <button
      type="button"
      data-testid="open-file"
      onClick={() => {
        rail.openAddress(address)
      }}
    >
      open
    </button>
  )
}

describe('重开同一份 = 聚焦，不开第二个', () => {
  it('点两次只有一个面板，而且没重挂', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('报价单.xlsx', await xlsxFixture()))
    const address = fileAddress('src_1', '报价单.xlsx')
    renderWithProviders(
      <RailStateProvider>
        <OpenTwice address={address} />
        <RightRail />
      </RailStateProvider>,
      '/knowledge',
    )
    fireEvent.click(screen.getByTestId('open-file'))
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-panel')).toBe('office-preview')
    const panel = await screen.findByTestId('rail-office', undefined, { timeout: 5000 })

    fireEvent.click(screen.getByTestId('open-file'))
    expect(screen.getAllByTestId('rail-panel-frame')).toHaveLength(1)
    // 同一个 DOM 节点 = 没有重挂（重挂会换一个新节点）
    expect(screen.getByTestId('rail-office')).toBe(panel)
  })

  it('没有面板认领的地址：回假，调用方该去下载', () => {
    ensureBuiltinPanels()
    let opened: boolean | undefined
    function Probe(): ReactNode {
      const rail = useRailState()
      opened = rail.openAddress(fileAddress('src_1', '合同.pdf'))
      return null
    }
    renderWithProviders(
      <RailStateProvider>
        <Probe />
      </RailStateProvider>,
      '/knowledge',
    )
    expect(opened).toBe(false)
  })
})

describe('照 WP96 的新风格画（共用件，不自己写一套）', () => {
  it('文件那一头是 WsCard，来源是 WsTag', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('报价单.xlsx', await xlsxFixture()))
    renderPanel('报价单.xlsx')
    const box = await screen.findByTestId('rail-office')
    expect(box.querySelector('.ws-card')).not.toBeNull()
    expect(screen.getAllByTestId('ws-tag').length).toBeGreaterThan(0)
  })

  it('画不出来那几句用状态胶囊，不是一行灰字', async () => {
    getKnowledgeSourceFile.mockResolvedValue({
      filename: '年度明细.xlsx',
      size: 21 * 1024 * 1024,
      content_type: 'application/octet-stream',
      too_large: true,
    })
    renderPanel('年度明细.xlsx')
    const pill = await screen.findByTestId('rail-office-too-large')
    expect(pill.dataset.tone).toBe('warn')
    expect(pill.className).toContain('rounded-full')
  })
})

describe('两条边界', () => {
  it('渲染树里没有 inline script，也没有一条外链', async () => {
    getKnowledgeSourceFile.mockResolvedValue(result('退货说明.docx', await docxFixture()))
    renderPanel('退货说明.docx')
    const body = await screen.findByTestId('rail-office-word-body')
    await vi.waitFor(() => {
      expect(body.textContent).toContain('退货窗口是 30 天')
    })
    const root = screen.getByTestId('rail-office')
    expect(root.querySelectorAll('script')).toHaveLength(0)
    const external = [...root.querySelectorAll('[src],[href]')]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
      .filter((url) => /^(https?:)?\/\//.test(url))
    expect(external).toEqual([])
  })

  it('文件内容一个字都不落到 localStorage（40 §1.2）', async () => {
    const map = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() {
        return map.size
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, String(v))
      },
      removeItem: (k: string) => {
        map.delete(k)
      },
      clear: () => {
        map.clear()
      },
    })
    try {
      getKnowledgeSourceFile.mockResolvedValue(result('报价单.xlsx', await xlsxFixture()))
      const address = fileAddress('src_1', '报价单.xlsx')
      renderWithProviders(
        <RailStateProvider>
          <OpenTwice address={address} />
          <RightRail />
        </RailStateProvider>,
        '/knowledge',
      )
      fireEvent.click(screen.getByTestId('open-file'))
      await screen.findByTestId('rail-office-sheet', undefined, { timeout: 5000 })
      const dump = [...map.values()].join('|')
      // 布局那一份进来了（结构），文件里的字一个都没有（内容）
      expect(dump).toContain('office-preview')
      for (const word of ['订单号', 'SO-2', '尺码不合', '报价单.xlsx'])
        expect(dump).not.toContain(word)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
