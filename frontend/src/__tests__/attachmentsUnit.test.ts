import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  composeInspectionInput,
  decodeText,
  inspect,
  looksBinary,
  resetMockDelayRange,
  setMockDelayRange,
  sniffMagic,
} from '../api'
import type { Attachment } from '../api'

function readableAttachment(
  text: string,
  fileName = '회의록.txt',
): Attachment {
  return {
    id: 'attachment-readable',
    fileName,
    sizeBytes: text.length,
    extension: '.txt',
    verdict: 'readable',
    encoding: 'utf-8',
    text,
    charCount: text.length,
  }
}

function unreadableAttachment(fileName = '자료.pdf'): Attachment {
  return {
    id: 'attachment-unreadable',
    fileName,
    sizeBytes: 8,
    extension: '.pdf',
    verdict: 'unreadable',
    reason: 'binary_format',
    sniffed: 'PDF',
  }
}

describe('첨부 판독 순수 함수', () => {
  beforeEach(() => {
    setMockDelayRange(0, 0)
  })

  afterEach(() => {
    resetMockDelayRange()
  })

  it('U-1 매직 넘버로 PDF, ZIP 계열 문서, PNG 이미지를 식별한다', () => {
    expect(sniffMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('PDF')
    expect(sniffMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('ZIP 계열 문서')
    expect(sniffMagic(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('PNG 이미지')
  })

  it('U-2 평범한 한글 UTF-8 바이트에는 매직 넘버가 없다', () => {
    const bytes = new TextEncoder().encode('회의록 요약 양식을 알려줘')

    expect(sniffMagic(bytes)).toBeNull()
  })

  it('U-3 NUL 바이트가 하나라도 있으면 바이너리로 판별한다', () => {
    const bytes = new Uint8Array([0x41, 0x00, 0x42])

    expect(looksBinary(bytes, 'A\u0000B')).toBe(true)
  })

  it('U-4 탭과 개행이 섞인 정상 로그는 바이너리가 아니다', () => {
    const text = '2026-09-02\tINFO\t검사 시작\r\n완료\n'

    expect(looksBinary(new TextEncoder().encode(text), text)).toBe(false)
  })

  it('U-5 UTF-8 BOM을 제거하고 첫 글자 오프셋을 보존한다', () => {
    const content = new TextEncoder().encode('첫 글자')
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...content])
    const decoded = decodeText(bytes)

    if (!decoded.ok) throw new Error('UTF-8 BOM 문서를 디코드하지 못했다.')
    expect(decoded.encoding).toBe('utf-8')
    expect(decoded.text).toBe('첫 글자')
    expect(decoded.text.charCodeAt(0)).not.toBe(0xfeff)
  })

  it('U-6 EUC-KR 바이트를 한글로 디코드한다', () => {
    const decoded = decodeText(new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]))

    expect(decoded).toEqual({
      ok: true,
      text: '한글',
      encoding: 'euc-kr',
    })
  })

  it('U-7 빈 본문과 읽힌 첨부를 합성할 때 앞에 빈 줄을 남기지 않는다', () => {
    const composed = composeInspectionInput('', [readableAttachment('첨부 내용')])

    expect(composed).toBe('--- 첨부1 ---\n\n첨부 내용')
    expect(composed.startsWith('\n')).toBe(false)
  })

  it('U-8 합성 검사 입력에 파일 이름을 넣지 않는다', () => {
    const fileName = '홍길동_주민번호_원본.txt'
    const composed = composeInspectionInput(
      '본문',
      [readableAttachment('첨부 내용', fileName)],
    )

    expect(composed).not.toContain(fileName)
    expect(composed).toContain('--- 첨부1 ---')
  })

  it('U-9 빈 파일은 합성 검사 입력에 넣지 않는다', () => {
    const empty: Attachment = {
      id: 'attachment-empty',
      fileName: '빈파일.txt',
      sizeBytes: 0,
      extension: '.txt',
      verdict: 'empty',
    }

    expect(composeInspectionInput('본문', [empty])).toBe('본문')
    expect(composeInspectionInput('', [empty])).toBe('')
  })

  it('U-10 판정 불가 첨부만 있는 검사 입력도 위험 등급으로 차단한다', async () => {
    const composed = composeInspectionInput('', [unreadableAttachment()])
    const result = await inspect(composed)

    expect(result.grade).toBe('blocked')
    expect(result.detections).toContainEqual(expect.objectContaining({
      type: 'unreadable_attachment',
      label: '판정 불가',
    }))
  })
})
