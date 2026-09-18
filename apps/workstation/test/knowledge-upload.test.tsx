/**
 * WP99：知识库页的**上传区**（19 §1.3 写口的界面那一侧）。
 *
 * 钉住六件：
 *
 * 1. 空库时这一块也在（"还没有上传过文件"不等于"没地方传"）；
 * 2. 选文件传：一份一份传，传完**立刻**出现在下面那一列；
 * 3. 拖进来也走同一条路；
 * 4. 前端预检：不收的扩展名 / 超大 / 空文件当场说，**一次网络都不发**；
 * 5. 服务端拒了：那句人话原样显示在这一份的那一格上，而且**后面几份照传**；
 * 6. 删除：点一下就没了。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeSource } from '@/lib/api'
import { renderWithProviders } from './helpers'

const sources: KnowledgeSource[] = []

const listKnowledgeSources = vi.fn(async () => [...sources])
const uploadKnowledgeSource = vi.fn<(file: File) => Promise<KnowledgeSource>>()
const deleteKnowledgeSource = vi.fn(async (id: string) => {
  const i = sources.findIndex((s) => s.id === id)
  if (i >= 0) sources.splice(i, 1)
  return { deleted: true as const, id }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listKnowledgeCards: async () => [],
    listKnowledgeRechecks: async () => [],
    listKnowledgeGaps: async () => [],
    listKnowledgeBoundaries: async () => [],
    listKnowledgeSources: () => listKnowledgeSources(),
    uploadKnowledgeSource: (f: File) => uploadKnowledgeSource(f),
    deleteKnowledgeSource: (id: string) => deleteKnowledgeSource(id),
  }
})

const { KnowledgePage } = await import('@/pages/knowledge')

/**
 * jsdom 的 `File` 不认 `size`（它拿 blob 部分算），所以超大那一档得改一格。
 * 只改这一格，别的都用真 `File`。
 */
function file(name: string, size = 8): File {
  const f = new File([new Uint8Array(Math.min(size, 1024))], name)
  if (size > 1024) Object.defineProperty(f, 'size', { value: size })
  return f
}

function source(id: string, filename: string): KnowledgeSource {
  return {
    id,
    workspace_id: 'ws_1',
    kind: 'upload',
    ref: `blob://knowledge/ws_1/${id}.xlsx`,
    parser: 'anydoc',
    acl_inherit: false,
    chunks: 0,
    filename,
  }
}

function reset(): void {
  sources.length = 0
  uploadKnowledgeSource.mockReset()
  listKnowledgeSources.mockClear()
  deleteKnowledgeSource.mockClear()
}

/** 把文件塞进那个隐藏 input 并触发 change（人点"选择文件"之后浏览器做的事）。 */
function pick(files: File[]): void {
  const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

describe('上传区', () => {
  it('空库时也在，而且写明收哪几种、多大', async () => {
    reset()
    renderWithProviders(<KnowledgePage />, '/knowledge')
    expect(await screen.findByTestId('knowledge-upload-drop')).toBeDefined()
    const kinds = screen.getByTestId('knowledge-upload-kinds').textContent ?? ''
    expect(kinds).toContain('docx')
    expect(kinds).toContain('pdf')
    expect(kinds).toContain('64')
    // 清单是另一条 query，要等它落下来（在此之前那一格是骨架）
    expect(await screen.findByTestId('knowledge-sources-empty')).toBeDefined()
  })

  it('选两份：一份一份传，传完立刻出现在下面那一列', async () => {
    reset()
    uploadKnowledgeSource.mockImplementation(async (f: File) => {
      const s = source(`src_${sources.length + 1}`, f.name)
      sources.push(s)
      return s
    })
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findByTestId('knowledge-upload-drop')

    pick([file('报价单.xlsx'), file('退货说明.docx')])

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-upload-item-1').dataset.state).toBe('done')
    })
    expect(uploadKnowledgeSource).toHaveBeenCalledTimes(2)
    // 列表刷过了，两份都在
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-source-src_1')).toBeDefined()
    })
    expect(screen.getByTestId('knowledge-source-src_2').textContent).toContain('退货说明.docx')
    // 名字从 `filename` 来，而不是从 `blob://…/<hash>` 里切最后一段
    expect(screen.getByTestId('knowledge-source-src_1').textContent).toContain('报价单.xlsx')
  })

  it('拖进来走同一条路（拖上去的时候那一块会高亮）', async () => {
    reset()
    uploadKnowledgeSource.mockImplementation(async (f: File) => {
      const s = source('src_9', f.name)
      sources.push(s)
      return s
    })
    renderWithProviders(<KnowledgePage />, '/knowledge')
    const drop = await screen.findByTestId('knowledge-upload-drop')

    fireEvent.dragOver(drop)
    expect(drop.dataset.dragging).toBe('yes')
    fireEvent.drop(drop, { dataTransfer: { files: [file('方案.pptx')] } })
    expect(drop.dataset.dragging).toBe('no')

    await waitFor(() => {
      expect(uploadKnowledgeSource).toHaveBeenCalledTimes(1)
    })
  })

  it('前端预检：不收的扩展名 / 超大 / 空文件当场说，一次网络都不发', async () => {
    reset()
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findByTestId('knowledge-upload-drop')

    pick([file('木马.exe'), file('年度明细.xlsx', 65 * 1024 * 1024), file('空的.txt', 0)])

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-upload-item-2').dataset.state).toBe('failed')
    })
    expect(uploadKnowledgeSource).not.toHaveBeenCalled()
    expect(screen.getByTestId('knowledge-upload-error-0').textContent).toContain('不收')
    expect(screen.getByTestId('knowledge-upload-error-1').textContent).toContain('64 MB')
    expect(screen.getByTestId('knowledge-upload-error-2').textContent).toContain('空文件')
  })

  it('服务端拒了：那句人话原样显示，而且后面几份照传', async () => {
    reset()
    uploadKnowledgeSource.mockImplementation(async (f: File) => {
      if (f.name === '假的.docx')
        throw new Error('这份文件的名字是 .docx，但里面装的不是 Word 的内容。')
      const s = source('src_3', f.name)
      sources.push(s)
      return s
    })
    renderWithProviders(<KnowledgePage />, '/knowledge')
    await screen.findByTestId('knowledge-upload-drop')

    pick([file('假的.docx'), file('真的.xlsx')])

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-upload-item-1').dataset.state).toBe('done')
    })
    expect(screen.getByTestId('knowledge-upload-item-0').dataset.state).toBe('failed')
    expect(screen.getByTestId('knowledge-upload-error-0').textContent).toContain('装的不是 Word')
    // 一份没上去不拦着后面那一份
    expect(uploadKnowledgeSource).toHaveBeenCalledTimes(2)
  })

  it('删除：点一下就没了', async () => {
    reset()
    sources.push(source('src_1', '报价单.xlsx'))
    renderWithProviders(<KnowledgePage />, '/knowledge')
    const remove = await screen.findByTestId('knowledge-source-remove-src_1')
    fireEvent.click(remove)
    await waitFor(() => {
      expect(deleteKnowledgeSource).toHaveBeenCalledWith('src_1')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('knowledge-source-src_1')).toBeNull()
    })
  })
})
