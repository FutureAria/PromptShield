import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent } from 'react'
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  clearActiveInspection,
  composeInspectionInput,
  formatBytes,
  getActiveInspection,
  getApprovalStatus,
  getStoredSession,
  inspect,
  readAttachment,
  reportFalsePositive,
  requestApproval,
  send,
} from '../api'
import type { Attachment } from '../api/attachments'
import type {
  ApprovalState,
  ApprovalStatus,
  ChatMessage,
  Detection,
  Grade,
  InspectionResult,
  Route,
} from '../api/types'
import { InspectionComparison } from '../components/InspectionComparison'
import '../styles/employee.css'

interface AttachmentChip {
  id: string
  fileName: string
  sizeBytes: number
  note: string
}

interface EmployeeMessage extends ChatMessage {
  approvalState?: ApprovalState
  // 본인 화면의 메모리 안에서만 보여 준다. 관리·감사 API에는 전달하지 않는다.
  attachmentChips?: AttachmentChip[]
}

interface ApprovalRoundTripContext {
  requestId: string
  inspection: InspectionResult
  draft: string
  attachments: Attachment[]
  userId: string | null
}

// SPA 안에서 관리자 화면을 왕복할 때 첨부 이름까지 유지하는 메모리 컨텍스트다.
// 시연 중 F5 복구를 위해 목 API는 검사 원문과 결과만 통합 sessionStorage에 보관한다.
// 파일 이름과 원본 바이트는 저장하지 않으며, 운영 백엔드에서는 서버가 상태를 소유해야 한다.
let approvalRoundTripContext: ApprovalRoundTripContext | null = null
let attachmentSequence = 0

const approvalMessageLabels: Record<ApprovalState, string> = {
  pending: '승인 요청함',
  approved: '승인됨',
  conditional: '조건부 승인됨',
  rejected: '반려됨',
}

function createApprovalMessage(
  inspection: InspectionResult,
  approvalState: ApprovalState,
  draft: string,
  attachments: readonly Attachment[],
): EmployeeMessage {
  return {
    id: `user-${inspection.requestId}`,
    role: 'user',
    text: draft,
    inspection,
    approvalState,
    attachmentChips: createAttachmentChips(attachments),
  }
}

function upsertApprovalMessage(
  messages: EmployeeMessage[],
  inspection: InspectionResult,
  approvalState: ApprovalState,
  draft: string,
  attachments: readonly Attachment[],
): EmployeeMessage[] {
  const messageId = `user-${inspection.requestId}`
  const exists = messages.some(({ id }) => id === messageId)

  if (!exists) {
    return [
      ...messages,
      createApprovalMessage(inspection, approvalState, draft, attachments),
    ]
  }

  return messages.map((message) => (
    message.id === messageId ? { ...message, approvalState } : message
  ))
}

function nextAttachmentId(): string {
  attachmentSequence += 1
  return `attachment-${attachmentSequence}`
}

function extensionOf(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.')
  return lastDot > 0 ? fileName.slice(lastDot).toLowerCase() : ''
}

const extensionsBySniffedFormat: Record<string, readonly string[]> = {
  PDF: ['.pdf'],
  'ZIP 계열 문서': ['.zip', '.docx', '.xlsx', '.pptx', '.hwpx', '.odt', '.ods', '.odp'],
  'OLE 문서': ['.hwp', '.doc', '.xls', '.ppt'],
  'PNG 이미지': ['.png'],
  'JPEG 이미지': ['.jpg', '.jpeg'],
  'GIF 이미지': ['.gif'],
  'RIFF 미디어': ['.webp', '.wav', '.avi'],
  'RAR 압축 파일': ['.rar'],
}

function hasMismatchedExtension(attachment: Attachment): boolean {
  if (!attachment.sniffed || !attachment.extension) return false
  const expected = extensionsBySniffedFormat[attachment.sniffed]
  return expected !== undefined && !expected.includes(attachment.extension)
}

function attachmentNote(attachment: Attachment): string {
  switch (attachment.verdict) {
    case 'reading':
      return '읽는 중'
    case 'readable':
      return `${(attachment.charCount ?? 0).toLocaleString('ko-KR')}자`
    case 'empty':
      return '빈 파일'
    case 'unreadable':
      return '판정 불가 · 내용 미전송'
  }
}

function createAttachmentChips(attachments: readonly Attachment[]): AttachmentChip[] | undefined {
  if (attachments.length === 0) return undefined
  return attachments.map((attachment) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    sizeBytes: attachment.sizeBytes,
    note: attachmentNote(attachment),
  }))
}

function isMechanicalAttachmentNote(note: string): boolean {
  return /^[\d,]+자$/.test(note)
}

function attachmentClass(attachment: Attachment): string {
  return attachment.verdict === 'unreadable'
    ? 'attachment attachment--unreadable'
    : 'attachment'
}

function attachmentStateCopy(attachment: Attachment) {
  if (attachment.verdict === 'reading') {
    return '읽는 중이다.'
  }

  if (attachment.verdict === 'readable') {
    return (
      <>
        <span className="attachment__fact">
          {(attachment.charCount ?? 0).toLocaleString('ko-KR')}자
        </span>
        <span aria-hidden="true"> · </span>
        <span className="attachment__fact">
          {attachment.encoding === 'euc-kr' ? 'EUC-KR' : 'UTF-8'}
        </span>
      </>
    )
  }

  if (attachment.verdict === 'empty') {
    return '빈 파일이다. 검사할 내용이 없다.'
  }

  switch (attachment.reason) {
    case 'binary_format':
      if (attachment.sniffed && hasMismatchedExtension(attachment)) {
        return (
          <>
            판정 불가 — 확장자는{' '}
            <span className="attachment__fact">{attachment.extension}</span>
            인데 실제 내용은 {attachment.sniffed}다. 내용을 확인할 수 없어 전송할 수 없다.
          </>
        )
      }
      return '판정 불가 — 이 형식은 내용을 확인할 수 없다. 필요한 부분만 텍스트로 붙여넣는다.'
    case 'encoding_unknown':
      return '판정 불가 — 글자 인코딩을 알아내지 못했다. 메모장에서 UTF-8로 다시 저장한 뒤 붙인다.'
    case 'too_long':
      return '판정 불가 — 20,000자를 넘어 검사하지 못했다. 필요한 부분만 텍스트로 붙여넣는다.'
    case 'read_failed':
    default:
      return '판정 불가 — 파일을 읽지 못했다. 제거한 뒤 다시 붙인다.'
  }
}

function updateApprovalMessage(
  messages: EmployeeMessage[],
  requestId: string,
  approvalState: ApprovalState,
): EmployeeMessage[] {
  const messageId = `user-${requestId}`
  return messages.map((message) => (
    message.id === messageId ? { ...message, approvalState } : message
  ))
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

const gradeLabels: Record<Grade, string> = {
  normal: '일반',
  caution: '주의',
  confidential: '기밀',
  blocked: '위험',
}

const routeLabels: Record<Route, string> = {
  external_llm: '외부 LLM',
  internal_llm: '사내 LLM',
  masked_external: '마스킹 후 전달',
  blocked: '전송 차단',
}

function decisionCopy(result: InspectionResult, approvalState?: ApprovalState) {
  const count = result.detections.length

  // 승인이 난 뒤에도 "차단했다"를 그대로 두면 같은 카드가 상반된 두 말을 한다.
  if (result.grade === 'blocked') {
    if (approvalState === 'approved') {
      return '관리자 승인으로 전송할 수 있다.'
    }
    if (approvalState === 'conditional') {
      return '관리자 조건부 승인으로 마스킹본만 전송할 수 있다.'
    }
  }

  switch (result.grade) {
    case 'normal':
      return '민감정보가 없어 그대로 전송할 수 있다.'
    case 'caution':
      return `민감정보 ${count}건을 가린 뒤 외부 LLM으로 전달한다.`
    case 'confidential':
      return '회사 기밀이 포함되어 외부로 전송하지 않고 사내 LLM에서 처리한다.'
    case 'blocked':
      return '외부 전송을 차단했다.'
  }
}

function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span className={`grade-badge grade-badge--${grade}`}>
      <span aria-hidden="true" className="grade-badge__dot" />
      {gradeLabels[grade]}
    </span>
  )
}

function RouteLabel({ route }: { route: Route }) {
  return <span className="route-label">처리 경로 · {routeLabels[route]}</span>
}

export default function EmployeePage() {
  const [messages, setMessages] = useState<EmployeeMessage[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentNotice, setAttachmentNotice] = useState('')
  const [isDropping, setIsDropping] = useState(false)
  const [inspection, setInspection] = useState<InspectionResult | null>(null)
  const [isInspecting, setIsInspecting] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isRequestingApproval, setIsRequestingApproval] = useState(false)
  const [isRestoringApproval, setIsRestoringApproval] = useState(true)
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus | null>(null)
  const [reportedDetectionIds, setReportedDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [reportingDetectionIds, setReportingDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dragDepthRef = useRef(0)
  const attachmentsRef = useRef<Attachment[]>([])

  const isBusy = (
    isInspecting
    || isSending
    || isRequestingApproval
    || isRestoringApproval
    || approvalStatus !== null
  )
  const hasReadingAttachment = attachments.some(({ verdict }) => verdict === 'reading')
  const unreadableCount = attachments.filter(({ verdict }) => verdict === 'unreadable').length

  useEffect(() => {
    let active = true
    setIsRestoringApproval(true)

    async function restoreInspection() {
      try {
        const storedInspection = await getActiveInspection()
        if (!active || !storedInspection) return

        const status = await getApprovalStatus(storedInspection.requestId)
        if (!active) return

        if (!status) {
          // 일반·주의·기밀과 아직 승인 요청 전인 위험 검사도 F5 뒤 카드를 복원한다.
          setInspection(storedInspection)
          setDraft(storedInspection.originalText)
          attachmentsRef.current = []
          setAttachments([])
          return
        }

        let context = approvalRoundTripContext
        if (!context || context.requestId !== storedInspection.requestId) {
          // 전체 새로고침에서는 파일 객체와 이름을 복원하지 않는다. 검사를 만들었던
          // 사용자에게만 API가 돌려준 원문·결과로 승인 왕복의 핵심 흐름을 이어 간다.
          context = {
            requestId: storedInspection.requestId,
            inspection: storedInspection,
            draft: storedInspection.originalText,
            attachments: [],
            userId: getStoredSession()?.userId ?? null,
          }
          approvalRoundTripContext = context
        }

        if (context.userId !== (getStoredSession()?.userId ?? null)) {
          // 같은 탭에서 계정을 전환해도 다른 직원의 입력 원문을 복원하지 않는다.
          return
        }

        setInspection(context.inspection)
        setDraft(context.draft)
        attachmentsRef.current = context.attachments
        setAttachments(context.attachments)
        setApprovalStatus(status)
        setMessages((current) => (
          upsertApprovalMessage(
            current,
            context.inspection,
            status.state,
            context.draft,
            context.attachments,
          )
        ))
      } catch {
        if (active) {
          setError('저장된 검사 결과를 불러오지 못했다. 잠시 후 다시 확인해 주세요.')
        }
      } finally {
        if (active) setIsRestoringApproval(false)
      }
    }

    void restoreInspection()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (approvalStatus?.state !== 'pending') return

    const requestId = approvalStatus.requestId
    let active = true

    async function pollApprovalStatus() {
      try {
        const status = await getApprovalStatus(requestId)
        if (!active) return

        if (!status) {
          clearActiveInspection(requestId)
          if (approvalRoundTripContext?.requestId === requestId) {
            approvalRoundTripContext = null
          }
          setApprovalStatus(null)
          setInspection(null)
          setDraft('')
          attachmentsRef.current = []
          setAttachments([])
          setAttachmentNotice('')
          setMessages((current) => (
            current.filter(({ id }) => id !== `user-${requestId}`)
          ))
          return
        }

        setApprovalStatus(status)
        setMessages((current) => (
          updateApprovalMessage(current, requestId, status.state)
        ))
      } catch {
        // 일시적인 폴링 실패는 다음 주기의 조회로 복구한다.
      }
    }

    void pollApprovalStatus()
    const timer = window.setInterval(() => {
      void pollApprovalStatus()
    }, 3000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [approvalStatus?.requestId, approvalStatus?.state])

  const finishApprovalRoundTrip = (requestId: string) => {
    if (approvalRoundTripContext?.requestId === requestId) {
      approvalRoundTripContext = null
    }
    setApprovalStatus(null)
  }

  const resetInspectionState = () => {
    if (approvalStatus) finishApprovalRoundTrip(approvalStatus.requestId)
    if (inspection) clearActiveInspection(inspection.requestId)
    setInspection(null)
    setReportedDetectionIds(new Set<string>())
    setReportingDetectionIds(new Set<string>())
    setError(null)
  }

  const changeAttachments = (
    updater: (current: Attachment[]) => Attachment[],
  ) => {
    const current = attachmentsRef.current
    const next = updater(current)
    if (next === current) return

    attachmentsRef.current = next
    setAttachments(next)

    // 첨부가 달라진 뒤 이전 결과를 전송할 수 없도록 즉시 폐기한다.
    if (inspection) resetInspectionState()
    else if (error) setError(null)
  }

  const handleFilesChosen = (files: FileList | readonly File[]) => {
    if (isBusy) return

    const selectedFiles = Array.from(files)
    if (selectedFiles.length === 0) return

    const current = attachmentsRef.current
    const readingAttachments: { attachment: Attachment; file: File }[] = []
    let nextCount = current.length
    let nextTotalBytes = current.reduce((sum, attachment) => (
      sum + attachment.sizeBytes
    ), 0)
    let notice = ''

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index]

      if (nextCount >= ATTACHMENT_MAX_COUNT) {
        const refusedCount = selectedFiles.length - index
        notice = `첨부는 3개까지 붙일 수 있다. ${refusedCount}개는 붙이지 않았다.`
        break
      }

      if (file.size > ATTACHMENT_MAX_BYTES) {
        notice = `${file.name}는 ${formatBytes(file.size)}다. 파일 하나는 1MB까지 붙일 수 있다. 필요한 부분만 텍스트로 붙여넣는다.`
        continue
      }

      if (nextTotalBytes + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
        notice = `첨부 합계 2MB를 넘어 ${file.name}는 붙이지 않았다.`
        continue
      }

      const id = nextAttachmentId()
      readingAttachments.push({
        attachment: {
          id,
          fileName: file.name,
          sizeBytes: file.size,
          extension: extensionOf(file.name),
          verdict: 'reading',
        },
        file,
      })
      nextCount += 1
      nextTotalBytes += file.size
    }

    if (readingAttachments.length === 0) {
      if (notice) setAttachmentNotice(notice)
      return
    }

    changeAttachments((items) => [
      ...items,
      ...readingAttachments.map(({ attachment }) => attachment),
    ])
    setAttachmentNotice(
      notice || `파일 ${readingAttachments.length}개를 첨부했다.`,
    )

    readingAttachments.forEach(({ attachment, file }) => {
      void readAttachment(attachment.id, file).then((result) => {
        changeAttachments((items) => (
          items.some(({ id }) => id === attachment.id)
            ? items.map((item) => (item.id === attachment.id ? result : item))
            : items
        ))
      })
    })
  }

  const handleAttachmentInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files
    if (files) handleFilesChosen(files)
    // 같은 파일을 제거한 뒤 곧바로 다시 고를 수 있게 선택값만 비운다.
    event.currentTarget.value = ''
  }

  const handleAttachmentRemove = (id: string) => {
    if (isBusy) return
    const index = attachmentsRef.current.findIndex((attachment) => attachment.id === id)
    if (index < 0) return

    changeAttachments((items) => items.filter((attachment) => attachment.id !== id))
    setAttachmentNotice(`첨부${index + 1}을 제거했다.`)
  }

  const handleDragEnter = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isBusy || !Array.from(event.dataTransfer.types).includes('Files')) return
    dragDepthRef.current += 1
    setIsDropping(true)
  }

  const handleDragOver = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
  }

  const handleDragLeave = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDropping(false)
  }

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDropping(false)
    if (isBusy) return
    handleFilesChosen(event.dataTransfer.files)
  }

  const handleInspect = async (event?: FormEvent) => {
    event?.preventDefault()
    if (isBusy) return

    if (hasReadingAttachment) {
      setAttachmentNotice('파일을 모두 읽은 뒤 검사할 수 있다.')
      return
    }

    if (!draft.trim() && attachments.length === 0) {
      setError('검사할 내용을 입력해 주세요.')
      textareaRef.current?.focus()
      return
    }

    setIsInspecting(true)
    setInspection(null)
    setReportedDetectionIds(new Set<string>())
    setReportingDetectionIds(new Set<string>())
    setError(null)

    try {
      const result = await inspect(composeInspectionInput(draft, attachments))
      setInspection(result)
    } catch {
      setError('검사를 완료하지 못했다. 잠시 후 다시 검사해 주세요.')
    } finally {
      setIsInspecting(false)
    }
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void handleInspect()
    }
  }

  const handleDraftChange = (value: string) => {
    setDraft(value)
    if (inspection) resetInspectionState()
    else if (error) setError(null)
  }

  const returnToEditing = () => {
    resetInspectionState()
    textareaRef.current?.focus()
  }

  const handleSend = async () => {
    if (!inspection || isSending) return
    if (
      inspection.grade === 'blocked'
      && approvalStatus?.state !== 'approved'
      && approvalStatus?.state !== 'conditional'
    ) return

    setIsSending(true)
    setError(null)
    const messageDraft = draft
    const messageAttachments = attachments

    try {
      const assistantMessage = await send(inspection.requestId)
      const userMessage: EmployeeMessage = {
        id: `user-${inspection.requestId}`,
        role: 'user',
        text: messageDraft,
        inspection,
        attachmentChips: createAttachmentChips(messageAttachments),
      }

      setMessages((current) => (
        inspection.grade === 'blocked'
          ? [...current, assistantMessage]
          : [...current, userMessage, assistantMessage]
      ))
      setDraft('')
      attachmentsRef.current = []
      setAttachments([])
      setAttachmentNotice('')
      resetInspectionState()
    } catch {
      setError('요청을 처리하지 못했다. 검사 결과는 유지했으니 다시 시도해 주세요.')
    } finally {
      setIsSending(false)
    }
  }

  const handleApprovalRequest = async () => {
    if (!inspection || inspection.grade !== 'blocked' || isRequestingApproval) return

    const requestingUserId = getStoredSession()?.userId ?? null
    setIsRequestingApproval(true)
    setError(null)
    try {
      await requestApproval(inspection.requestId)
      const status = await getApprovalStatus(inspection.requestId)
      if (!status) throw new Error('생성된 승인 요청의 상태를 찾을 수 없다.')

      approvalRoundTripContext = {
        requestId: inspection.requestId,
        inspection,
        draft,
        attachments: [...attachments],
        userId: requestingUserId,
      }
      setApprovalStatus(status)
      setMessages((current) => (
        upsertApprovalMessage(current, inspection, status.state, draft, attachments)
      ))
    } catch {
      setError('승인 요청을 보내지 못했다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setIsRequestingApproval(false)
    }
  }

  const handleFalsePositive = async (detection: Detection) => {
    if (!inspection || reportingDetectionIds.has(detection.id)) return

    setReportingDetectionIds((current) => new Set(current).add(detection.id))
    setError(null)
    try {
      await reportFalsePositive(inspection.requestId, detection.id)
      setReportedDetectionIds((current) => new Set(current).add(detection.id))
    } catch {
      setError('오탐 신고를 접수하지 못했다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setReportingDetectionIds((current) => {
        const next = new Set(current)
        next.delete(detection.id)
        return next
      })
    }
  }

  const renderActions = (result: InspectionResult) => {
    if (result.grade === 'blocked') {
      if (approvalStatus?.state === 'pending') return null

      if (approvalStatus?.state === 'approved') {
        return (
          <button
            className="button button--primary"
            disabled={isSending}
            onClick={() => void handleSend()}
            type="button"
          >
            {isSending ? '처리 중' : '원문 그대로 전송'}
          </button>
        )
      }

      if (approvalStatus?.state === 'conditional') {
        return (
          <button
            className="button button--primary"
            disabled={isSending}
            onClick={() => void handleSend()}
            type="button"
          >
            {isSending ? '처리 중' : '마스킹본 전송'}
          </button>
        )
      }

      if (approvalStatus?.state === 'rejected') {
        return (
          <button className="button button--primary" onClick={returnToEditing} type="button">
            수정 후 재검사
          </button>
        )
      }

      return (
        <>
          <button className="button button--disabled" disabled type="button">
            전송 차단됨
          </button>
          <button className="button button--primary" onClick={returnToEditing} type="button">
            문제 구간 제거 후 재검사
          </button>
          <button
            className="button button--secondary"
            disabled={isRequestingApproval}
            onClick={() => void handleApprovalRequest()}
            type="button"
          >
            {isRequestingApproval ? '승인 요청 중' : '관리자 승인 요청'}
          </button>
        </>
      )
    }

    const sendLabel = {
      normal: '그대로 전송',
      caution: '가리고 보내기',
      confidential: '사내 LLM으로 처리',
    }[result.grade]

    return (
      <>
        <button
          className="button button--primary"
          disabled={isSending}
          onClick={() => void handleSend()}
          type="button"
        >
          {isSending ? '처리 중' : sendLabel}
        </button>
        {result.grade !== 'normal' && (
          <button className="button button--secondary" onClick={returnToEditing} type="button">
            수정 후 재검사
          </button>
        )}
      </>
    )
  }

  const inspectionActions = inspection ? renderActions(inspection) : null

  return (
    <main className="employee-page" id="main-content">
      <header className="employee-intro">
        <p className="eyebrow">직원용 보안 게이트웨이</p>
        <h1>AI에 보내기 전에 확인한다</h1>
        <p>
          업무 내용을 먼저 검사하면 민감한 부분을 가리거나 안전한 사내 경로로 보낸다.
        </p>
      </header>

      <section className="conversation" aria-labelledby="conversation-heading">
        <div className="section-heading">
          <h2 id="conversation-heading">대화</h2>
          <span className="mono">{messages.length}건</span>
        </div>

        {messages.length === 0 ? (
          <div className="conversation__empty">
            <p>아직 대화가 없다.</p>
            <span>아래에 요청을 적으면 외부 전송 전에 먼저 검사한다.</span>
          </div>
        ) : (
          <ol className="message-list" aria-live="polite">
            {messages.map((message) => (
              <li className={`message message--${message.role}`} key={message.id}>
                <div className="message__meta">
                  <span>{message.role === 'user' ? '나' : 'AI 응답'}</span>
                  {message.role === 'user' && message.inspection && (
                    <GradeBadge grade={message.inspection.grade} />
                  )}
                  {message.role === 'assistant' && message.route && (
                    <RouteLabel route={message.route} />
                  )}
                  {message.role === 'user' && message.approvalState && (
                    <span className="message__approval-state">
                      {approvalMessageLabels[message.approvalState]}
                    </span>
                  )}
                </div>
                <p>{message.text}</p>
                {message.attachmentChips?.length ? (
                  <ul className="message__attachments" aria-label="첨부 파일">
                    {message.attachmentChips.map((chip) => (
                      <li className="message__attachment" key={chip.id}>
                        <span aria-hidden="true">📎</span>
                        <span className="message__attachment-name" title={chip.fileName}>
                          {chip.fileName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="attachment__size">{formatBytes(chip.sizeBytes)}</span>
                        <span aria-hidden="true">·</span>
                        <span className={
                          isMechanicalAttachmentNote(chip.note) ? 'attachment__fact' : undefined
                        }>
                          {chip.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="composer-section" aria-labelledby="composer-heading">
        <div className="section-heading">
          <h2 id="composer-heading">보낼 내용</h2>
          <span className="keyboard-hint">⌘/Ctrl + Enter</span>
        </div>
        <form
          className={`composer${isDropping ? ' composer--dropping' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onSubmit={(event) => void handleInspect(event)}
        >
          <label className="sr-only" htmlFor="prompt-input">
            AI에게 보낼 내용
          </label>
          <textarea
            disabled={isBusy}
            id="prompt-input"
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="예: 회의록 요약 양식을 알려줘"
            ref={textareaRef}
            rows={5}
            value={draft}
          />
          {attachments.length > 0 && (
            <ul className="attachments">
              {attachments.map((attachment, index) => (
                <li className={attachmentClass(attachment)} key={attachment.id}>
                  <div className="attachment__head">
                    <span className="attachment__ordinal">첨부{index + 1}</span>
                    <span className="attachment__name" title={attachment.fileName}>
                      {attachment.fileName}
                    </span>
                    <span className="attachment__size">
                      {formatBytes(attachment.sizeBytes)}
                    </span>
                    <button
                      aria-label={`첨부${index + 1} 제거`}
                      className="text-button"
                      disabled={isBusy}
                      onClick={() => handleAttachmentRemove(attachment.id)}
                      type="button"
                    >
                      제거
                    </button>
                  </div>
                  <p className="attachment__state">{attachmentStateCopy(attachment)}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="composer__footer">
            <span className="composer__count mono">
              {draft.length}자
              {attachments.length > 0 ? ` · 첨부 ${attachments.length}건` : ''}
            </span>
            <div className="composer__actions">
              <label className="button button--secondary composer__attach" htmlFor="attachment-input">
                파일 첨부
              </label>
              <input
                accept={ATTACHMENT_ACCEPT}
                className="sr-only"
                disabled={isBusy}
                id="attachment-input"
                multiple
                onChange={handleAttachmentInputChange}
                type="file"
              />
              <button
                className="button button--primary composer__submit"
                disabled={
                  isBusy
                  || hasReadingAttachment
                  || (!draft.trim() && attachments.length === 0)
                }
                type="submit"
              >
                {isInspecting ? '검사 중' : '검사'}
              </button>
            </div>
          </div>
        </form>
        {attachments.length > 0 && (
          <p className="attachments__hint">
            파일 이름은 검사·전송·기록 어디에도 남기지 않는다. 첨부는 순번으로만 표시한다.
          </p>
        )}
        {attachmentNotice && (
          <p aria-live="polite" className="attachments__notice" role="status">
            {attachmentNotice}
          </p>
        )}
      </section>

      <div aria-live="polite">
        {isInspecting && (
          <div className="state-panel" role="status">
            <span className="state-panel__indicator" aria-hidden="true" />
            <div>
              <strong>입력 내용을 검사하고 있다.</strong>
              <p>민감정보 위치와 안전한 처리 경로를 확인한다.</p>
            </div>
          </div>
        )}

        {error && (
          <div className="state-panel state-panel--error" role="alert">
            <div>
              <strong>처리를 마치지 못했다.</strong>
              <p>{error}</p>
            </div>
          </div>
        )}
      </div>

      {inspection && (
        <section
          aria-labelledby="inspection-heading"
          className={`inspection-card inspection-card--${inspection.grade}`}
        >
          <div className="inspection-card__topline">
            <div>
              <p className="eyebrow">검사 결과</p>
              <h2 id="inspection-heading">
                <GradeBadge grade={inspection.grade} />
                <span>{decisionCopy(inspection, approvalStatus?.state)}</span>
              </h2>
            </div>
            <RouteLabel
              route={
                inspection.grade === 'blocked' && approvalStatus?.state === 'approved'
                  ? 'external_llm'
                  : inspection.grade === 'blocked' && approvalStatus?.state === 'conditional'
                    ? 'masked_external'
                    : inspection.route
              }
            />
          </div>

          <dl className="inspection-card__facts">
            <div>
              <dt>요청 ID</dt>
              <dd className="mono">{inspection.requestId}</dd>
            </div>
            <div>
              <dt>검사 시간</dt>
              <dd className="mono">{inspection.elapsedMs}ms</dd>
            </div>
            <div>
              <dt>탐지</dt>
              <dd className="mono">{inspection.detections.length}건</dd>
            </div>
            {attachments.length > 0 && (
              <div>
                <dt>첨부</dt>
                <dd className="mono">{attachments.length}건</dd>
              </div>
            )}
            {unreadableCount > 0 && (
              <div>
                <dt>판정 불가</dt>
                <dd className="mono">{unreadableCount}건</dd>
              </div>
            )}
          </dl>

          {inspection.reason
            && approvalStatus?.state !== 'approved'
            && approvalStatus?.state !== 'conditional' && (
            <p className="inspection-card__reason">
              <strong>차단 사유</strong>
              {inspection.reason}
            </p>
          )}

          <InspectionComparison
            onReportFalsePositive={(detection) => void handleFalsePositive(detection)}
            reportedDetectionIds={reportedDetectionIds}
            reportingDetectionIds={reportingDetectionIds}
            result={inspection}
          />

          {unreadableCount > 0 && (
            <p className="inspection-card__attachment-note">
              판정 불가 첨부의 내용은 읽지 못했으므로 전송되지 않는다. 본문과 읽어낸 첨부만 나간다.
            </p>
          )}

          {isSending && (
            <p className="inspection-card__progress" role="status">
              {inspection.grade === 'blocked' && approvalStatus?.state === 'approved'
                ? '승인된 원문을 보내고 있다.'
                : inspection.grade === 'blocked' && approvalStatus?.state === 'conditional'
                  ? '승인된 마스킹본을 보내고 있다.'
                  : inspection.grade === 'confidential'
                ? '외부로 전송하지 않고 사내에서 처리 중'
                : '안전한 전송본을 보내고 있다.'}
            </p>
          )}
          {approvalStatus && (
            <div
              className={`approval-status approval-status--${approvalStatus.state}`}
              role="status"
            >
              <strong>
                {approvalStatus.state === 'pending'
                  ? '관리자 승인을 기다리는 중'
                  : approvalStatus.state === 'approved'
                    ? '관리자가 승인했다'
                    : approvalStatus.state === 'conditional'
                      ? '관리자가 마스킹본 전송을 조건으로 승인했다'
                      : '관리자가 반려했다'}
              </strong>

              {approvalStatus.state === 'pending' ? (
                <>
                  <p>승인 요청을 보냈다. 처리 결과가 정해지면 이 화면에 바로 표시한다.</p>
                  <dl className="approval-status__facts">
                    <div>
                      <dt>요청 시각</dt>
                      <dd>
                        <time dateTime={approvalStatus.requestedAt}>
                          {formatDateTime(approvalStatus.requestedAt)}
                        </time>
                      </dd>
                    </div>
                  </dl>
                </>
              ) : (
                <dl className="approval-status__facts">
                  {approvalStatus.decidedBy && (
                    <div>
                      <dt>결정자</dt>
                      <dd>{approvalStatus.decidedBy}</dd>
                    </div>
                  )}
                  {approvalStatus.decidedAt && (
                    <div>
                      <dt>결정 시각</dt>
                      <dd>
                        <time dateTime={approvalStatus.decidedAt}>
                          {formatDateTime(approvalStatus.decidedAt)}
                        </time>
                      </dd>
                    </div>
                  )}
                </dl>
              )}

              {approvalStatus.state === 'rejected' && approvalStatus.rejectionReason && (
                <div className="approval-status__rejection">
                  <span>반려 사유</span>
                  <p>{approvalStatus.rejectionReason}</p>
                </div>
              )}
            </div>
          )}

          {attachments.length > 0 && (
            <p className="inspection-card__attachment-clear">
              전송하면 첨부 {attachments.length}건이 목록에서 비워진다.
            </p>
          )}

          {inspectionActions && (
            <div className="inspection-card__actions">{inspectionActions}</div>
          )}
        </section>
      )}
    </main>
  )
}
