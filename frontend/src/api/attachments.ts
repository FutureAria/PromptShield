export const ATTACHMENT_MAX_COUNT = 3
export const ATTACHMENT_MAX_BYTES = 1024 * 1024
export const ATTACHMENT_MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const ATTACHMENT_MAX_TEXT_LENGTH = 20_000

/** 대화상자를 좁히는 유도 장치일 뿐 통과권이 아니다. 판정은 언제나 바이트가 한다. */
export const ATTACHMENT_ACCEPT =
  '.txt,.md,.csv,.tsv,.log,.json,.yaml,.yml,.xml,.sql,.ini,.conf,text/plain'

export type AttachmentVerdict = 'reading' | 'readable' | 'empty' | 'unreadable'

export type AttachmentUnreadableReason =
  | 'binary_format'
  | 'encoding_unknown'
  | 'too_long'
  | 'read_failed'

export interface Attachment {
  id: string
  fileName: string
  sizeBytes: number
  extension: string
  verdict: AttachmentVerdict
  reason?: AttachmentUnreadableReason
  sniffed?: string
  encoding?: 'utf-8' | 'euc-kr'
  text?: string
  charCount?: number
}

export type DecodeResult =
  | { ok: true; text: string; encoding: 'utf-8' | 'euc-kr' }
  | { ok: false }

const MAGIC_SIGNATURES: readonly { bytes: readonly number[]; name: string }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46], name: 'PDF' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP 계열 문서' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], name: 'ZIP 계열 문서' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], name: 'ZIP 계열 문서' },
  {
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    name: 'OLE 문서',
  },
  { bytes: [0x89, 0x50, 0x4e, 0x47], name: 'PNG 이미지' },
  { bytes: [0xff, 0xd8, 0xff], name: 'JPEG 이미지' },
  { bytes: [0x47, 0x49, 0x46, 0x38], name: 'GIF 이미지' },
  { bytes: [0x52, 0x49, 0x46, 0x46], name: 'RIFF 미디어' },
  { bytes: [0x52, 0x61, 0x72, 0x21], name: 'RAR 압축 파일' },
  { bytes: [0x7f, 0x45, 0x4c, 0x46], name: '실행 파일' },
]

const BINARY_SAMPLE_BYTES = 8192
const CONTROL_RATIO_LIMIT = 0.01

function extensionOf(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot > 0 ? fileName.slice(lastDot).toLowerCase() : ''
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const { result } = reader
      if (result instanceof ArrayBuffer) {
        resolve(result)
      } else {
        reject(new Error('파일을 바이트로 읽지 못했다.'))
      }
    }
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했다.'))
    reader.readAsArrayBuffer(file)
  })
}

export function sniffMagic(bytes: Uint8Array): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) {
      return signature.name
    }
  }
  return null
}

export function looksBinary(bytes: Uint8Array, text: string): boolean {
  const sample = bytes.subarray(0, Math.min(BINARY_SAMPLE_BYTES, bytes.length))
  if (sample.length === 0) return false

  let control = 0
  for (const byte of sample) {
    if (byte === 0x00) return true
    const allowed = byte === 0x09 || byte === 0x0a || byte === 0x0d
    if ((byte < 0x20 && !allowed) || byte === 0x7f) control += 1
  }
  if (control / sample.length > CONTROL_RATIO_LIMIT) return true

  const replacement = (text.match(/\uFFFD/g) ?? []).length
  return text.length > 0 && replacement / text.length > CONTROL_RATIO_LIMIT
}

export function decodeText(bytes: Uint8Array): DecodeResult {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes

  try {
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: true }).decode(body),
      encoding: 'utf-8',
    }
  } catch {
    // UTF-8이 아니면 지원하는 두 번째 인코딩을 시도한다.
  }

  try {
    return {
      ok: true,
      text: new TextDecoder('euc-kr', { fatal: true }).decode(body),
      encoding: 'euc-kr',
    }
  } catch {
    // 두 지원 인코딩으로 모두 읽지 못했다.
  }

  return { ok: false }
}

/** 크기 관문은 호출자가 바이트를 읽기 전에 통과시킨다. */
export async function readAttachment(id: string, file: File): Promise<Attachment> {
  const base: Pick<Attachment, 'id' | 'fileName' | 'sizeBytes' | 'extension'> = {
    id,
    fileName: file.name,
    sizeBytes: file.size,
    extension: extensionOf(file.name),
  }

  if (file.size === 0) {
    return { ...base, verdict: 'empty' }
  }

  try {
    const buffer = await readArrayBuffer(file)
    const bytes = new Uint8Array(buffer)
    const sniffed = sniffMagic(bytes)

    if (sniffed) {
      return {
        ...base,
        verdict: 'unreadable',
        reason: 'binary_format',
        sniffed,
      }
    }

    const hasUtf16Bom = (
      (bytes[0] === 0xff && bytes[1] === 0xfe)
      || (bytes[0] === 0xfe && bytes[1] === 0xff)
    )
    if (hasUtf16Bom) {
      return { ...base, verdict: 'unreadable', reason: 'encoding_unknown' }
    }

    const decoded = decodeText(bytes)
    if (!decoded.ok) {
      return { ...base, verdict: 'unreadable', reason: 'encoding_unknown' }
    }

    if (looksBinary(bytes, decoded.text)) {
      return { ...base, verdict: 'unreadable', reason: 'binary_format' }
    }

    if (decoded.text.length > ATTACHMENT_MAX_TEXT_LENGTH) {
      return { ...base, verdict: 'unreadable', reason: 'too_long' }
    }

    return {
      ...base,
      verdict: 'readable',
      encoding: decoded.encoding,
      text: decoded.text,
      charCount: decoded.text.length,
    }
  } catch {
    return { ...base, verdict: 'unreadable', reason: 'read_failed' }
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** 파일 이름은 넣지 않고 본문과 판독 결과를 한 번의 검사 입력으로 합친다. */
export function composeInspectionInput(
  prompt: string,
  attachments: readonly Attachment[],
): string {
  const parts: string[] = []
  if (prompt.trim().length > 0) parts.push(prompt)

  attachments.forEach((attachment, index) => {
    const ordinal = index + 1
    if (attachment.verdict === 'readable' && attachment.text !== undefined) {
      parts.push(`--- 첨부${ordinal} ---`)
      parts.push(normalizeNewlines(attachment.text))
    } else if (attachment.verdict === 'unreadable') {
      parts.push(`--- 첨부${ordinal} · 내용을 읽지 못함 ---`)
    }
  })

  return parts.join('\n\n')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
