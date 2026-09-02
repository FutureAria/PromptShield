import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import {
  DictionaryValidationError,
  getDictionary,
  inspect,
  login,
  previewInspection,
  resetMockDelayRange,
  resetMockDictionary,
  resetMockUsers,
  saveDictionary,
  send,
  setMockDelayRange,
} from '../api'
import type { DictionaryDraftEntry } from '../api'

function renderAppAt(pathname: string) {
  return render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={[pathname]}
    >
      <App />
    </MemoryRouter>,
  )
}

function toDraft(entries: Awaited<ReturnType<typeof getDictionary>>['entries']): DictionaryDraftEntry[] {
  return entries.map((entry) => ({
    rowId: entry.id,
    id: entry.id,
    term: entry.term,
    entryType: entry.entryType,
    grade: entry.grade,
    active: entry.active,
    note: entry.note,
  }))
}

describe('기업 사전 API와 화면', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    resetMockDelayRange()
    resetMockDictionary()
    resetMockUsers()
  })

  it('사전 저장이 직원 화면의 검사 결과를 바꾼다', async () => {
    await login('sec-park')
    const before = await inspect('X-100 견적 만들어줘')
    expect(before.grade).toBe('normal')

    const snapshot = await getDictionary()
    await saveDictionary({
      baseRevision: snapshot.revision,
      entries: [
        ...toDraft(snapshot.entries),
        {
          rowId: 'new-x-100',
          term: 'X-100',
          entryType: 'product_code',
          grade: 'confidential',
          active: true,
          note: '시연용 제품코드',
        },
      ],
    })

    const after = await inspect('X-100 견적 만들어줘')
    expect(after.grade).toBe('confidential')
    expect(after.detections[0]?.label).toBe('제품코드')
    expect(after.maskedText).toContain('[제품1]')
  })

  it('시험 검사 결과는 전송 경로에 들어가지 않는다', async () => {
    const preview = await previewInspection('ABC상사 견적')

    await expect(send(preview.draft.requestId)).rejects.toThrow('검사 결과를 찾을 수 없다')
  })

  it('감사자는 사전을 조회할 수 있지만 저장할 수 없다', async () => {
    await login('aud-lee')
    const snapshot = await getDictionary()

    await expect(saveDictionary({
      baseRevision: snapshot.revision,
      entries: toDraft(snapshot.entries),
    })).rejects.toThrow('사전을 수정할 권한이 없다.')
  })

  it('검증 오류가 있는 초안은 저장하지 않는다', async () => {
    await login('sec-park')
    const snapshot = await getDictionary()

    try {
      await saveDictionary({
        baseRevision: snapshot.revision,
        entries: [
          ...toDraft(snapshot.entries),
          {
            rowId: 'too-short',
            term: '한',
            entryType: 'other',
            grade: 'caution',
            active: true,
            note: '',
          },
        ],
      })
      throw new Error('검증 오류가 발생하지 않았다.')
    } catch (error) {
      expect(error).toBeInstanceOf(DictionaryValidationError)
      expect((error as DictionaryValidationError).issues.some(
        (issue) => issue.code === 'term_too_short',
      )).toBe(true)
    }
  })

  it('낙관적 잠금 충돌이면 사전 revision을 바꾸지 않는다', async () => {
    await login('sec-park')
    const snapshot = await getDictionary()

    await expect(saveDictionary({
      baseRevision: 0,
      entries: toDraft(snapshot.entries),
    })).rejects.toThrow(/^다른 관리자가 사전을 먼저 저장했다/)

    expect((await getDictionary()).revision).toBe(snapshot.revision)
  })

  it('감사자 사전 화면에는 편집 조작을 렌더하지 않는다', async () => {
    await login('aud-lee')
    renderAppAt('/admin/dictionary')

    expect(await screen.findByRole('heading', { name: '기업 사전', level: 1 })).toBeVisible()
    expect(screen.queryByRole('button', { name: '저장' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '행 추가' })).not.toBeInTheDocument()
  })
})
