import { useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  inspect,
  reportFalsePositive,
  requestApproval,
  send,
} from '../api'
import type {
  ChatMessage,
  Detection,
  Grade,
  InspectionResult,
  Route,
} from '../api/types'
import { InspectionComparison } from '../components/InspectionComparison'
import '../styles/employee.css'

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

function decisionCopy(result: InspectionResult) {
  const count = result.detections.length

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [inspection, setInspection] = useState<InspectionResult | null>(null)
  const [isInspecting, setIsInspecting] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isRequestingApproval, setIsRequestingApproval] = useState(false)
  const [approvalRequested, setApprovalRequested] = useState(false)
  const [reportedDetectionIds, setReportedDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [reportingDetectionIds, setReportingDetectionIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resetInspectionState = () => {
    setInspection(null)
    setApprovalRequested(false)
    setReportedDetectionIds(new Set<string>())
    setReportingDetectionIds(new Set<string>())
    setError(null)
  }

  const handleInspect = async (event?: FormEvent) => {
    event?.preventDefault()
    if (isInspecting || isSending) return

    if (!draft.trim()) {
      setError('검사할 내용을 입력해 주세요.')
      textareaRef.current?.focus()
      return
    }

    setIsInspecting(true)
    setInspection(null)
    setApprovalRequested(false)
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
    if (!inspection || inspection.grade === 'blocked' || isSending) return

    setIsSending(true)
    setError(null)

    try {
      const assistantMessage = await send(inspection.requestId)
      const userMessage: ChatMessage = {
        id: `user-${inspection.requestId}`,
        role: 'user',
        text: inspection.originalText,
        inspection,
      }

      setMessages((current) => [...current, userMessage, assistantMessage])
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
      setApprovalRequested(true)
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
            disabled={isRequestingApproval || approvalRequested}
            onClick={() => void handleApprovalRequest()}
            type="button"
          >
            {approvalRequested
              ? '승인 요청 보냄'
              : isRequestingApproval
                ? '승인 요청 중'
                : '관리자 승인 요청'}
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
            disabled={isInspecting || isSending}
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
              disabled={isInspecting || isSending || !draft.trim()}
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
                <span>{decisionCopy(inspection)}</span>
              </h2>
            </div>
            <RouteLabel route={inspection.route} />
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

          {inspection.reason && (
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
              {inspection.grade === 'confidential'
                ? '외부로 전송하지 않고 사내에서 처리 중'
                : '안전한 전송본을 보내고 있다.'}
            </p>
          )}
          {approvalRequested && (
            <p className="inspection-card__progress" role="status">
              관리자에게 승인 요청을 보냈다. 처리 결과는 이 화면에서 확인할 수 있다.
            </p>
          )}

          <div className="inspection-card__actions">{renderActions(inspection)}</div>
        </section>
      )}
    </main>
  )
}
