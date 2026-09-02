import { Fragment, useEffect, useRef, useState } from 'react'
import { decideApproval, getPendingApprovals } from '../api'
import type { PendingApproval } from '../api/types'

type ApprovalDecision = 'approved' | 'conditional' | 'rejected'

const decisionMessages: Record<ApprovalDecision, string> = {
  approved: '요청을 승인했다.',
  conditional: '마스킹본 전송으로 조건부 승인했다.',
  rejected: '요청을 반려했다.',
}

function formatDateTime(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function MaskedPreview({ text }: { text: string }) {
  const segments = text.split(/(\[[^\]]+\d+\])/g)
  return (
    <p className="masked-preview">
      {segments.map((segment, index) => (
        /^\[[^\]]+\d+\]$/.test(segment)
          ? <code key={`${segment}-${index}`}>{segment}</code>
          : <Fragment key={`${segment}-${index}`}>{segment}</Fragment>
      ))}
    </p>
  )
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<PendingApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [toast, setToast] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const toastTimer = useRef<number | null>(null)

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      try {
        const pending = await getPendingApprovals()
        if (active) setItems(pending)
      } catch {
        if (active) setError('승인 대기 요청을 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [reloadKey])

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
  }, [])

  function showToast(message: string) {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3600)
  }

  async function handleDecision(id: string, decision: ApprovalDecision) {
    if (decision === 'rejected' && !rejectReason.trim()) {
      setActionError('반려하는 이유를 한 줄 이상 적어 주세요.')
      return
    }

    setBusyId(id)
    setActionError('')
    try {
      await decideApproval(id, decision, decision === 'rejected' ? rejectReason.trim() : undefined)
      setItems((current) => current.filter((item) => item.id !== id))
      setRejectingId(null)
      setRejectReason('')
      showToast(decisionMessages[decision])
    } catch {
      setActionError('요청을 처리하지 못했다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="admin-page approvals-page">
      <header className="admin-page__header">
        <div>
          <p className="admin-page__eyebrow">관리자 판단</p>
          <h1>승인 대기</h1>
          <p>원문 없이 마스킹된 내용과 탐지 근거만 보고 처리한다.</p>
        </div>
        {!loading && !error ? (
          <span className="admin-result-count" aria-live="polite">
            <span className="mono-fact"><strong>{items.length}</strong>건</span> 대기
          </span>
        ) : null}
      </header>

      <div className="approval-guidance" role="note">
        <p>
          업무상 필요하지만 원문 전송이 불필요한 요청은 <strong>조건부 승인 — 마스킹본 전송</strong>을 선택한다.
        </p>
      </div>

      {actionError ? <p className="action-error" role="alert">{actionError}</p> : null}

      {loading ? (
        <section className="admin-status admin-status--inline" aria-live="polite">
          <span className="admin-spinner" aria-hidden="true" />
          <h2>승인 대기 요청을 불러오는 중이다</h2>
          <p>마스킹된 미리보기와 탐지 요약을 확인하고 있다.</p>
        </section>
      ) : error ? (
        <section className="admin-status admin-status--inline" role="alert">
          <h2>승인 대기 요청을 표시하지 못했다</h2>
          <p>{error}</p>
          <button className="admin-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
            다시 불러오기
          </button>
        </section>
      ) : items.length === 0 ? (
        <section className="admin-empty admin-empty--panel">
          <h2>기다리는 승인 요청이 없다</h2>
          <p>새 요청이 생기면 이곳에서 승인, 조건부 승인, 반려 중 하나를 선택할 수 있다.</p>
        </section>
      ) : (
        <div className="approval-list">
          {items.map((item) => {
            const isBusy = busyId === item.id
            const isAnyBusy = busyId !== null
            const isRejecting = rejectingId === item.id
            return (
              <article className="approval-card" key={item.id} aria-labelledby={`approval-${item.id}`}>
                <header className="approval-card__header">
                  <div>
                    <h2 id={`approval-${item.id}`}>{item.userName}</h2>
                    <span>{item.department}</span>
                  </div>
                  <time dateTime={item.at}>{formatDateTime(item.at)}</time>
                </header>

                <div className="approval-card__body">
                  <div className="approval-reason">
                    <span className="field-label">차단 사유</span>
                    <p>{item.reason}</p>
                  </div>

                  <div>
                    <span className="field-label">탐지 요약</span>
                    <ul className="approval-detections">
                      {item.detectionSummary.map((detected) => (
                        <li key={detected.label}>
                          <span>{detected.label}</span>
                          <strong>{detected.count}</strong>
                          <span className="mono-fact">건</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <span className="field-label">마스킹된 미리보기</span>
                    <MaskedPreview text={item.maskedPreview} />
                  </div>
                </div>

                {isRejecting ? (
                  <div className="reject-form">
                    <label htmlFor={`reject-reason-${item.id}`}>반려 사유</label>
                    <textarea
                      id={`reject-reason-${item.id}`}
                      rows={3}
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      placeholder="요청자가 이해할 수 있는 이유를 적어 주세요"
                      autoFocus
                    />
                    <div className="reject-form__actions">
                      <button
                        className="admin-button"
                        type="button"
                        disabled={isAnyBusy || !rejectReason.trim()}
                        onClick={() => void handleDecision(item.id, 'rejected')}
                      >
                        {isBusy ? '처리 중' : '반려 확정'}
                      </button>
                      <button
                        className="admin-button admin-button--quiet"
                        type="button"
                        disabled={isAnyBusy}
                        onClick={() => {
                          setRejectingId(null)
                          setRejectReason('')
                          setActionError('')
                        }}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="approval-actions" aria-label={`${item.userName} 요청 처리`}>
                  <button
                    className="approval-action"
                    type="button"
                    disabled={isAnyBusy}
                    onClick={() => void handleDecision(item.id, 'approved')}
                  >
                    {isBusy ? '처리 중' : '승인'}
                  </button>
                  <button
                    className="approval-action"
                    type="button"
                    disabled={isAnyBusy}
                    onClick={() => void handleDecision(item.id, 'conditional')}
                  >
                    조건부 승인
                    <small>마스킹본 전송</small>
                  </button>
                  <button
                    className="approval-action"
                    type="button"
                    disabled={isAnyBusy}
                    aria-expanded={isRejecting}
                    onClick={() => {
                      setRejectingId(item.id)
                      setRejectReason('')
                      setActionError('')
                    }}
                  >
                    반려
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {toast ? <div className="admin-toast" role="status">{toast}</div> : null}
    </div>
  )
}
