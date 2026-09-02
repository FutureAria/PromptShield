import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES,
  getPendingApprovals,
  resetMockDelayRange,
  setMockDelayRange,
} from '../api'
import EmployeePage from '../pages/EmployeePage'

function makeUser() {
  // accept는 대화상자 유도일 뿐 통과권이 아니다. 테스트에서도 PDF·이미지를 직접 고른다.
  return userEvent.setup({ applyAccept: false })
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('파일 첨부')
}

function textFile(text: string, name = '회의록.txt'): File {
  return new File([new TextEncoder().encode(text)], name, { type: 'text/plain' })
}

function pdfFile(name = '암호화문서.pdf'): File {
  return new File([
    new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Encrypt 2 0 R >>'),
  ], name, { type: 'application/pdf' })
}

function pngFile(name = '화면.png'): File {
  return new File([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ], name, { type: 'image/png' })
}

async function getInspectionCard(name: RegExp): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name })
  const card = heading.closest('.inspection-card')
  if (!(card instanceof HTMLElement)) {
    throw new Error('검사 결과 카드를 찾지 못했다.')
  }
  return card
}

describe('직원 화면 첨부 경로', () => {
  beforeEach(() => {
    sessionStorage.clear()
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    cleanup()
    sessionStorage.clear()
    resetMockDelayRange()
  })

  it('A-1 첨부가 0건이면 첨부 목록·힌트·검사 결과 fact가 없다', async () => {
    const user = makeUser()
    const { container } = render(<EmployeePage />)

    expect(container.querySelector('.attachments')).toBeNull()
    expect(container.querySelector('.attachments__hint')).toBeNull()

    await user.type(
      screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }),
      '회의록 요약 양식을 알려줘',
    )
    await user.click(screen.getByRole('button', { name: '검사' }))

    const card = await getInspectionCard(/일반.*민감정보가 없어 그대로 전송할 수 있다/)
    expect(within(card).queryByText('첨부')).not.toBeInTheDocument()
    expect(within(card).queryByText('판정 불가')).not.toBeInTheDocument()
  })

  it('A-2 암호화 PDF만 첨부해도 일반으로 통과하지 않고 승인 경로를 연다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.upload(fileInput(), pdfFile())
    await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/위험.*외부 전송을 차단했다/)
    expect(screen.queryByRole('button', { name: '그대로 전송' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '전송 차단됨' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '관리자 승인 요청' })).toBeVisible()
  })

  it('A-3 일반 본문에 PNG를 첨부하면 전체 등급이 위험으로 오른다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.type(
      screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }),
      '회의록 요약 양식을 알려줘',
    )
    await user.upload(fileInput(), pngFile())
    await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/위험.*외부 전송을 차단했다/)
  })

  it('A-4 확장자만 txt로 바꾼 PDF의 실제 형식을 알린다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.upload(fileInput(), pdfFile('보고서.txt'))

    // 확장자는 모노로 보이려고 별도 span 이라 문구가 요소 경계를 넘는다.
    // 카드 전체의 텍스트로 확인한다.
    const card = await screen.findByText('보고서.txt')
    expect(card.closest('li')).toHaveTextContent(
      /확장자는 \.txt인데 실제 내용은 PDF다/,
    )
  })

  it('A-5 txt 파일에 NUL 바이트가 있으면 판정 불가로 처리한다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const file = new File(
      [new Uint8Array([0x41, 0x00, 0x42])],
      '바이너리.txt',
      { type: 'text/plain' },
    )

    await user.upload(fileInput(), file)

    expect(await screen.findByText(
      /판정 불가 — 이 형식은 내용을 확인할 수 없다/,
    )).toBeVisible()
  })

  it('A-6 EUC-KR 한글 txt를 읽고 그 안의 이름을 탐지한다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const file = new File(
      [new Uint8Array([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf])],
      '이름.txt',
      { type: 'text/plain' },
    )

    await user.upload(fileInput(), file)
    expect(await screen.findByText('EUC-KR')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/주의.*민감정보 1건을 가린 뒤/)
    expect(screen.getByText('이름', { selector: '.detections__name' })).toBeVisible()
  })

  it('A-7 UTF-8 txt의 전화번호를 탐지하고 전송본에서 원문을 제거한다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const phone = '010-0000-0000'

    await user.upload(fileInput(), textFile(`연락처는 ${phone}입니다.`, '연락처.txt'))
    expect(await screen.findByText('UTF-8')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/주의.*민감정보 1건을 가린 뒤/)
    const transmission = screen.getByLabelText('전송본', { selector: 'p' })
    expect(transmission).toHaveTextContent('[전화1]')
    expect(transmission).not.toHaveTextContent(phone)
  })

  it('A-8 파일 이름을 전송본과 검사 결과 카드에 노출하지 않는다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const fileName = '홍길동_주민번호_원본.txt'

    await user.upload(fileInput(), textFile('연락처는 010-0000-0000입니다.', fileName))
    expect(await screen.findByText('UTF-8')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '검사' }))

    const card = await getInspectionCard(/주의.*민감정보 1건을 가린 뒤/)
    const transmission = screen.getByLabelText('전송본', { selector: 'p' })
    expect(card).not.toHaveTextContent(fileName)
    expect(transmission).not.toHaveTextContent(fileName)
  })

  it('A-9 판정 불가 승인 요청의 관리자 데이터에 파일 이름을 넣지 않는다', async () => {
    const user = makeUser()
    const approvalsBefore = await getPendingApprovals()
    const previousIds = new Set(approvalsBefore.map(({ id }) => id))
    const fileName = '홍길동_주민번호_원본.pdf'
    render(<EmployeePage />)

    await user.upload(fileInput(), pdfFile(fileName))
    await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)
    await user.click(screen.getByRole('button', { name: '검사' }))
    await user.click(await screen.findByRole('button', { name: '관리자 승인 요청' }))
    await screen.findByText('관리자 승인을 기다리는 중')

    const approvalsAfter = await getPendingApprovals()
    const created = approvalsAfter.find(({ id }) => !previousIds.has(id))
    expect(created).toBeDefined()
    if (!created) throw new Error('새 승인 요청을 찾지 못했다.')

    expect(created.detectionSummary).toContainEqual({ label: '판정 불가', count: 1 })
    expect(created.maskedPreview).toContain('[판독불가1]')
    expect(created.maskedPreview).not.toContain(fileName)
    expect(created.reason).not.toContain(fileName)
  })

  it('A-10 검사 뒤 첨부를 추가하면 이전 검사 결과를 폐기한다', async () => {
    const user = makeUser()
    const { container } = render(<EmployeePage />)

    await user.type(
      screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }),
      '회의록 요약 양식을 알려줘',
    )
    await user.click(screen.getByRole('button', { name: '검사' }))
    await getInspectionCard(/일반.*민감정보가 없어 그대로 전송할 수 있다/)

    await user.upload(fileInput(), textFile('추가 자료'))
    await screen.findByText('UTF-8')

    await waitFor(() => {
      expect(container.querySelector('.inspection-card')).toBeNull()
    })
  })

  it('A-11 검사 뒤 첨부를 제거하면 이전 검사 결과를 폐기한다', async () => {
    const user = makeUser()
    const { container } = render(<EmployeePage />)

    await user.upload(fileInput(), textFile('회의록 요약 양식을 알려줘'))
    await screen.findByText('UTF-8')
    await user.click(screen.getByRole('button', { name: '검사' }))
    await getInspectionCard(/일반.*민감정보가 없어 그대로 전송할 수 있다/)

    await user.click(screen.getByRole('button', { name: '첨부1 제거' }))

    await waitFor(() => {
      expect(container.querySelector('.inspection-card')).toBeNull()
    })
  })

  it('A-12 전송이 끝나면 현재 첨부 목록을 비운다', async () => {
    const user = makeUser()
    const { container } = render(<EmployeePage />)

    await user.upload(fileInput(), textFile('회의록 요약 양식을 알려줘'))
    await screen.findByText('UTF-8')
    await user.click(screen.getByRole('button', { name: '검사' }))
    await getInspectionCard(/일반.*민감정보가 없어 그대로 전송할 수 있다/)
    await user.click(screen.getByRole('button', { name: '그대로 전송' }))
    await screen.findByText(/요청한 내용을 확인했다/)

    await waitFor(() => {
      expect(container.querySelector('.attachments')).toBeNull()
    })
  })

  it('A-13 네 번째 파일은 붙이지 않고 3개 상한을 알린다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const files = [1, 2, 3, 4].map((index) => textFile(`자료 ${index}`, `자료${index}.txt`))

    await user.upload(fileInput(), files)

    expect(await screen.findByText(/첨부는 3개까지 붙일 수 있다/)).toBeVisible()
    expect(screen.getAllByRole('button', { name: /첨부\d+ 제거/ })).toHaveLength(3)
  })

  it('A-14 1MB를 넘는 파일은 목록에 넣지 않고 크기 상한을 알린다', async () => {
    const user = makeUser()
    const { container } = render(<EmployeePage />)
    const file = new File(
      [new Uint8Array(ATTACHMENT_MAX_BYTES + 1)],
      '큰파일.txt',
      { type: 'text/plain' },
    )

    await user.upload(fileInput(), file)

    expect(await screen.findByText(/큰파일\.txt는 1\.0MB다/)).toBeVisible()
    expect(screen.getByText(/파일 하나는 1MB까지 붙일 수 있다/)).toBeVisible()
    expect(container.querySelector('.attachments')).toBeNull()
  })

  it('A-15 0바이트 파일만 첨부하면 일반 등급으로 그대로 전송할 수 있다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.upload(fileInput(), new File([], '빈파일.txt', { type: 'text/plain' }))
    expect(await screen.findByText('빈 파일이다. 검사할 내용이 없다.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/일반.*민감정보가 없어 그대로 전송할 수 있다/)
    expect(screen.getByRole('button', { name: '그대로 전송' })).toBeEnabled()
  })

  it('A-16 판정 불가 탐지에는 오탐 신고 버튼을 표시하지 않는다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.upload(fileInput(), pdfFile())
    await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)
    await user.click(screen.getByRole('button', { name: '검사' }))
    await getInspectionCard(/위험.*외부 전송을 차단했다/)

    const label = screen.getByText('판정 불가', { selector: '.detections__name' })
    const item = label.closest('li')
    if (!(item instanceof HTMLElement)) throw new Error('판정 불가 탐지 항목을 찾지 못했다.')
    expect(within(item).queryByRole('button', { name: '오탐 신고' })).not.toBeInTheDocument()
  })

  it('A-17 파일 첨부 label이 실제 다중 file input을 가리킨다', () => {
    render(<EmployeePage />)

    const input = fileInput()
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('multiple')
  })

  it('A-18 드롭으로 붙인 파일도 파일 input과 같은 판정 결과를 낸다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const file = pdfFile()
    const zone = screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }).closest('form')
    if (!(zone instanceof HTMLFormElement)) throw new Error('첨부 드롭 영역을 찾지 못했다.')

    fireEvent.drop(zone, {
      dataTransfer: {
        files: [file],
        items: [],
        types: ['Files'],
      },
    })

    expect(await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/위험.*외부 전송을 차단했다/)
  })

  it('완료 기준: 주민등록번호가 든 txt는 차단하고 승인 경로를 연다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.upload(
      fileInput(),
      textFile('주민등록번호 000000-0000000 확인해줘', '주민번호.txt'),
    )
    await screen.findByText('UTF-8')
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/위험.*외부 전송을 차단했다/)
    expect(screen.getByRole('button', { name: '전송 차단됨' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '관리자 승인 요청' })).toBeVisible()
  })

  it('완료 기준: 일반 본문과 거래처 csv를 함께 검사하면 전체가 기밀로 오른다', async () => {
    const user = makeUser()
    render(<EmployeePage />)

    await user.type(
      screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }),
      '회의록 요약 양식을 알려줘',
    )
    await user.upload(
      fileInput(),
      textFile('거래처,요청\nABC상사,견적 작성', '거래처.csv'),
    )
    await screen.findByText('UTF-8')
    await user.click(screen.getByRole('button', { name: '검사' }))

    await getInspectionCard(/기밀.*회사 기밀이 포함되어/)
    expect(screen.getByText('처리 경로 · 사내 LLM')).toBeVisible()
  })

  it('D-23 승인 왕복 재마운트에서도 첨부 목록을 메모리에서 복원한다', async () => {
    const user = makeUser()
    render(<EmployeePage />)
    const fileName = '승인대상.pdf'

    await user.upload(fileInput(), pdfFile(fileName))
    await screen.findByText(/판정 불가 — 이 형식은 내용을 확인할 수 없다/)
    await user.click(screen.getByRole('button', { name: '검사' }))
    await user.click(await screen.findByRole('button', { name: '관리자 승인 요청' }))
    await screen.findByText('관리자 승인을 기다리는 중')

    cleanup()
    const { container } = render(<EmployeePage />)
    await screen.findByText('관리자 승인을 기다리는 중')

    const list = container.querySelector('.attachments')
    expect(list).not.toBeNull()
    expect(list).toHaveTextContent(fileName)
  })
})
