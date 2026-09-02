import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspect, resetMockDelayRange, setMockDelayRange } from '../api'
import EmployeePage from '../pages/EmployeePage'

async function inspectFromEmployeeScreen(text: string) {
  const user = userEvent.setup()
  render(<EmployeePage />)

  await user.type(screen.getByRole('textbox', { name: 'AI에게 보낼 내용' }), text)
  await user.click(screen.getByRole('button', { name: '검사' }))

  return user
}

describe('직원 화면 주요 시나리오', () => {
  beforeEach(() => {
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    cleanup()
    resetMockDelayRange()
  })

  it('G-01 정상 전송: 민감정보가 없으면 그대로 전송할 수 있다', async () => {
    await inspectFromEmployeeScreen('회의록 요약 양식을 알려줘')

    const heading = await screen.findByRole('heading', {
      name: /일반.*민감정보가 없어 그대로 전송할 수 있다/,
    })
    const inspectionCard = heading.closest('section')

    expect(inspectionCard).not.toBeNull()
    expect(within(inspectionCard!).getByText('0건')).toBeVisible()
    expect(screen.getByText('탐지된 민감정보가 없다')).toBeVisible()
    expect(screen.getByRole('button', { name: '그대로 전송' })).toBeEnabled()
  })

  it('G-02 마스킹 후 전송: 이름·전화번호·이메일을 전송본에서 제거한다', async () => {
    const originalValues = ['홍길동', '010-0000-0000', 'hong@example.com']
    await inspectFromEmployeeScreen(
      '홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘',
    )

    const heading = await screen.findByRole('heading', {
      name: /주의.*민감정보 3건을 가린 뒤 외부 LLM으로 전달한다/,
    })
    const inspectionCard = heading.closest('section')

    expect(inspectionCard).not.toBeNull()
    expect(within(inspectionCard!).getByText('3건', {
      selector: '.inspection-card__facts dd',
    })).toBeVisible()

    const transmission = screen.getByLabelText('전송본', { selector: 'p' })
    for (const originalValue of originalValues) {
      expect(transmission).not.toHaveTextContent(originalValue)
    }
    expect(transmission).toHaveTextContent('[이름1]')
    expect(transmission).toHaveTextContent('[전화1]')
    expect(transmission).toHaveTextContent('[이메일1]')
    expect(screen.getByRole('button', { name: '가리고 보내기' })).toBeEnabled()
  })

  it('G-03 내부 LLM 처리: 기밀 요청을 사내 LLM으로 보내고 외부 미전송을 알린다', async () => {
    const user = await inspectFromEmployeeScreen(
      'ABC상사 X-100 단가 12,000원 견적 문구 만들어줘',
    )

    await screen.findByRole('heading', {
      name: /기밀.*회사 기밀이 포함되어 외부로 전송하지 않고 사내 LLM에서 처리한다/,
    })
    expect(screen.getByText('처리 경로 · 사내 LLM')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '사내 LLM으로 처리' }))

    expect(await screen.findByText(
      /사내 LLM에서 처리했다\. 이 요청은 외부로 전송되지 않았다\./,
    )).toBeVisible()
    expect(screen.getByText('처리 경로 · 사내 LLM')).toBeVisible()
  })

  it('G-04 전송 차단: 주민등록번호가 있으면 전송을 막고 승인 경로를 제공한다', async () => {
    await inspectFromEmployeeScreen('주민등록번호 000000-0000000 확인해줘')

    await screen.findByRole('heading', {
      name: /위험.*외부 전송을 차단했다/,
    })
    expect(screen.getByText(
      /고유식별정보 또는 비밀 키가 포함되어 전송을 차단했다/,
    )).toBeVisible()
    expect(screen.getByRole('button', { name: '전송 차단됨' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '관리자 승인 요청' })).toBeVisible()
  })
})

describe('마스킹 오프셋', () => {
  beforeEach(() => {
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    resetMockDelayRange()
  })

  it('뒤쪽 구간부터 치환해 앞선 탐지 위치가 밀리지 않는다', async () => {
    const text = '앞 홍길동 중간 hong@example.com 뒤 010-0000-0000 끝'
    const result = await inspect(text)

    expect(result.detections.map(({ start, end }) => [start, end])).toEqual([
      [2, 5],
      [9, 25],
      [28, 41],
    ])
    expect(result.detections.map(({ start, end }) => text.slice(start, end))).toEqual([
      '홍길동',
      'hong@example.com',
      '010-0000-0000',
    ])
    expect(result.maskedText).toBe(
      '앞 [이름1] 중간 [이메일1] 뒤 [전화1] 끝',
    )
  })

  it('구간이 겹치면 심각도가 높은 탐지를 남긴다', async () => {
    // 전화번호 패턴이 주민등록번호 패턴보다 앞에서 시작하지만,
    // 낮은 등급이 높은 등급을 덮으면 원문 일부가 마스킹되지 않은 채 외부로 나간다.
    const result = await inspect('제 번호는 010-1234567-1234567 입니다.')

    expect(result.grade).toBe('blocked')
    expect(result.route).toBe('blocked')
    expect(result.detections.map(({ label }) => label)).toContain('주민등록번호')
    expect(result.maskedText).not.toContain('1234567')
  })
})
