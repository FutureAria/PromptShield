import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  getApprovalStatus,
  inspect,
  reportFalsePositive,
  requestApproval,
  send,
} from '../api'
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

const PENDING_APPROVAL_STORAGE_KEY = 'promptshield.pendingApprovalRequestId'

interface EmployeeMessage extends ChatMessage {
  approvalState?: ApprovalState
}

interface ApprovalRoundTripContext {
  requestId: string
  inspection: InspectionResult
}

// SPA 안에서 관리자 화면을 왕복할 때만 쓰는 메모리 컨텍스트다.
// 원문이나 검사 결과를 sessionStorage 등 영속 저장소에 기록하지 않는다.
let approvalRoundTripContext: ApprovalRoundTripContext | null = null

const approvalMessageLabels: Record<ApprovalState, string> = {
  pending: '승인 요청함',
  approved: '승인됨',
  conditional: '조건부 승인됨',
  rejected: '반려됨',
}

function readPendingApprovalRequestId(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_APPROVAL_STORAGE_KEY)
  } catch {
    return null
  }
}

function storePendingApprovalRequestId(requestId: string): void {
  try {
    window.sessionStorage.setItem(PENDING_APPROVAL_STORAGE_KEY, requestId)
  } catch {
    // 저장소를 사용할 수 없어도 현재 화면에서는 승인 흐름을 계속 진행한다.
  }
}

function clearPendingApprovalRequestId(requestId: string): void {
  try {
    if (window.sessionStorage.getItem(PENDING_APPROVAL_STORAGE_KEY) === requestId) {
      window.sessionStorage.removeItem(PENDING_APPROVAL_STORAGE_KEY)
    }
  } catch {
    // 저장소 접근 실패는 화면의 승인 처리 결과에 영향을 주지 않는다.
  }
}

function createApprovalMessage(
  inspection: InspectionResult,
  approvalState: ApprovalState,
): EmployeeMessage {
  return {
    id: `user-${inspection.requestId}`,
    role: 'user',
    text: inspection.originalText,
    inspection,
    approvalState,
  }
}

function upsertApprovalMessage(
  messages: EmployeeMessage[],
  inspection: InspectionResult,
  approvalState: ApprovalState,
): EmployeeMessage[] {
  const messageId = `user-${inspection.requestId}`
  const exists = messages.some(({ id }) => id === messageId)

  if (!exists) {
    return [...messages, createApprovalMessage(inspection, approvalState)]
  }

  return messages.map((message) => (
    message.id === messageId ? { ...message, approvalState } : message
  ))
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
  const [inspection, setInspection] = useState<InspectionResult | null>(null)
  const [isInspecting, setIsInspecting] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isRequestingApproval, setIsRequestingApproval] = useState(false)
  const [isRestoringApproval, setIsRestoringApproval] = useState(
    () => readPendingApprovalRequestId() !== null,
  )
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus | null>(null)
  const [reportedDetectionIds, setReportedDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [reportingDetectionIds, setReportingDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const storedRequestId = readPendingApprovalRequestId()
    if (!storedRequestId) {
      setIsRestoringApproval(false)
      return
    }
    const requestId = storedRequestId

    let active = true
    setIsRestoringApproval(true)

    async function restoreApproval() {
      try {
        const status = await getApprovalStatus(requestId)
        if (!active) return

        if (!status) {
          clearPendingApprovalRequestId(requestId)
          if (approvalRoundTripContext?.requestId === requestId) {
            approvalRoundTripContext = null
          }
          return
        }

        const context = approvalRoundTripContext
        if (!context || context.requestId !== requestId) {
          // ApprovalStatus에는 의도적으로 원문이 없으므로 검사 컨텍스트 없이
          // 복원할 수 없다. 정상적인 새로고침에서는 목 상태도 함께 사라져 null이다.
          clearPendingApprovalRequestId(requestId)
          return
        }

        setInspection(context.inspection)
        setDraft(context.inspection.originalText)
        setApprovalStatus(status)
        setMessages((current) => (
          upsertApprovalMessage(current, context.inspection, status.state)
        ))
      } catch {
        if (active) {
          setError('승인 처리 결과를 불러오지 못했다. 잠시 후 다시 확인해 주세요.')
        }
      } finally {
        if (active) setIsRestoringApproval(false)
      }
    }

    void restoreApproval()
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
          clearPendingApprovalRequestId(requestId)
          if (approvalRoundTripContext?.requestId === requestId) {
            approvalRoundTripContext = null
          }
          setApprovalStatus(null)
          setInspection(null)
          setDraft('')
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
    clearPendingApprovalRequestId(requestId)
    if (approvalRoundTripContext?.requestId === requestId) {
      approvalRoundTripContext = null
    }
    setApprovalStatus(null)
  }

  const resetInspectionState = () => {
    if (approvalStatus) finishApprovalRoundTrip(approvalStatus.requestId)
    setInspection(null)
    setReportedDetectionIds(new Set<string>())
    setReportingDetectionIds(new Set<string>())
    setError(null)
  }

  const handleInspect = async (event?: FormEvent) => {
    event?.preventDefault()
    if (isInspecting || isSending || isRequestingApproval || isRestoringApproval) return

    if (!draft.trim()) {
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
      const result = await inspect(draft)
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

    try {
      const assistantMessage = await send(inspection.requestId)
      const userMessage: EmployeeMessage = {
        id: `user-${inspection.requestId}`,
        role: 'user',
        text: inspection.originalText,
        inspection,
      }

      setMessages((current) => (
        inspection.grade === 'blocked'
          ? [...current, assistantMessage]
          : [...current, userMessage, assistantMessage]
      ))
      setDraft('')
      resetInspectionState()
    } catch {
      setError('요청을 처리하지 못했다. 검사 결과는 유지했으니 다시 시도해 주세요.')
    } finally {
      setIsSending(false)
    }
  }

  const handleApprovalRequest = async () => {
    if (!inspection || inspection.grade !== 'blocked' || isRequestingApproval) return

    setIsRequestingApproval(true)
    setError(null)
    try {
      await requestApproval(inspection.requestId)
      const status = await getApprovalStatus(inspection.requestId)
      if (!status) throw new Error('생성된 승인 요청의 상태를 찾을 수 없다.')

      approvalRoundTripContext = {
        requestId: inspection.requestId,
        inspection,
      }
      storePendingApprovalRequestId(inspection.requestId)
      setApprovalStatus(status)
      setMessages((current) => (
        upsertApprovalMessage(current, inspection, status.state)
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
        <form className="composer" onSubmit={(event) => void handleInspect(event)}>
          <label className="sr-only" htmlFor="prompt-input">
            AI에게 보낼 내용
          </label>
          <textarea
            disabled={
              isInspecting
              || isSending
              || isRequestingApproval
              || isRestoringApproval
              || approvalStatus !== null
            }
            id="prompt-input"
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="예: 회의록 요약 양식을 알려줘"
            ref={textareaRef}
            rows={5}
            value={draft}
          />
          <div className="composer__footer">
            <span className="composer__count mono">{draft.length}자</span>
            <button
              className="button button--primary composer__submit"
              disabled={
                isInspecting
                || isSending
                || isRequestingApproval
                || isRestoringApproval
                || approvalStatus !== null
                || !draft.trim()
              }
              type="submit"
            >
              {isInspecting ? '검사 중' : '검사'}
            </button>
          </div>
        </form>
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

          {inspectionActions && (
            <div className="inspection-card__actions">{inspectionActions}</div>
          )}
        </section>
      )}
    </main>
  )
}
