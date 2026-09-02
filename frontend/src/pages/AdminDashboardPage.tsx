import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { can, getDashboard, getPendingApprovals, resetDemoState } from '../api'
import type { DashboardSummary, Grade, PendingApproval } from '../api/types'
import { useSession } from '../auth/SessionContext'
import { GradeBadge, gradeLabels } from '../components/Status'

const gradeOrder: Grade[] = ['normal', 'caution', 'confidential', 'blocked']

function formatShortDate(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
  }).format(date)
}

function formatDateTime(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export default function AdminDashboardPage() {
  const { session } = useSession()
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [resetConfirming, setResetConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')
  const [resetNotice, setResetNotice] = useState('')

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      try {
        const [dashboardData, pendingData] = await Promise.all([
          getDashboard(),
          getPendingApprovals(),
        ])
        if (!active) return
        setSummary(dashboardData)
        setPending(pendingData)
      } catch {
        if (active) setError('관리 현황을 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [reloadKey])

  const totalRequests = useMemo(
    () => summary ? gradeOrder.reduce((total, grade) => total + summary.byGrade[grade], 0) : 0,
    [summary],
  )

  const canDecideApprovals = session
    ? can(session.role, 'admin.approvals.decide')
    : false
  const canResetDemo = session
    ? can(session.role, 'admin.demo.reset')
    : false

  async function handleDemoReset() {
    setResetting(true)
    setResetError('')
    setResetNotice('')

    try {
      await resetDemoState()
      setResetConfirming(false)
      setResetNotice('시연용 데이터를 처음 상태로 돌렸다. 현재 로그인은 유지된다.')
      setReloadKey((value) => value + 1)
    } catch {
      setResetError('시연용 데이터를 초기화하지 못했다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <section className="admin-status" aria-live="polite">
        <span className="admin-spinner" aria-hidden="true" />
        <h1>관리 현황을 불러오는 중이다</h1>
        <p>승인 대기 요청과 최근 탐지 기록을 확인하고 있다.</p>
      </section>
    )
  }

  if (error || !summary) {
    return (
      <section className="admin-status" role="alert">
        <h1>관리 현황을 표시하지 못했다</h1>
        <p>{error || '알 수 없는 오류가 발생했다.'}</p>
        <button className="admin-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
          다시 불러오기
        </button>
      </section>
    )
  }

  const maxBlocked = Math.max(1, ...summary.blockedTrend.map((point) => point.count))
  const maxDetection = Math.max(1, ...summary.byDetectionType.map((item) => item.count))

  return (
    <div className="admin-page">
      <header className="admin-page__header">
        <div>
          <p className="admin-page__eyebrow">오늘의 관리 업무</p>
          <h1>관리 현황</h1>
          <p>처리가 필요한 요청을 먼저 확인하고, 최근 탐지 흐름을 살핀다.</p>
        </div>
      </header>

      {canResetDemo ? (
        <section className="demo-reset" aria-labelledby="demo-reset-heading">
          <div className="demo-reset__copy">
            <p className="admin-section__label">발표 복구 도구</p>
            <h2 id="demo-reset-heading">시연용 데이터 초기화</h2>
            <p>검사·승인·감사 로그, 기업 사전과 계정 역할을 준비된 씨앗 값으로 돌린다.</p>
          </div>

          {resetConfirming ? (
            <div className="demo-reset__confirm" role="group" aria-label="시연용 데이터 초기화 확인">
              <p>지금껏 만든 시연 상태가 사라진다. 초기화할까?</p>
              <div className="demo-reset__actions">
                <button
                  className="admin-button admin-button--quiet"
                  disabled={resetting}
                  type="button"
                  onClick={() => {
                    setResetConfirming(false)
                    setResetError('')
                  }}
                >
                  취소
                </button>
                <button
                  className="admin-button"
                  disabled={resetting}
                  type="button"
                  onClick={() => void handleDemoReset()}
                >
                  {resetting ? '초기화하는 중' : '초기화 실행'}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="admin-button admin-button--quiet"
              type="button"
              onClick={() => {
                setResetConfirming(true)
                setResetError('')
                setResetNotice('')
              }}
            >
              시연 데이터 초기화
            </button>
          )}

          {resetError ? <p className="demo-reset__message" role="alert">{resetError}</p> : null}
          {resetNotice ? <p className="demo-reset__message" role="status">{resetNotice}</p> : null}
        </section>
      ) : null}

      <section className="admin-section admin-section--priority" aria-labelledby="pending-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">먼저 할 일</p>
            <h2 id="pending-heading">승인 대기</h2>
          </div>
          {canDecideApprovals && (
            <Link className="admin-text-link" to="/admin/approvals">
              전체 대기 요청 보기
            </Link>
          )}
        </div>

        <div className="pending-overview">
          <div className="pending-count" aria-label={`승인 대기 ${summary.pendingCount}건`}>
            <span>처리할 요청</span>
            <strong>{summary.pendingCount}</strong>
            <span className="mono-fact">건</span>
          </div>

          <div className="pending-summary-list">
            {pending.length === 0 ? (
              <p className="admin-empty admin-empty--compact">지금 기다리는 승인 요청이 없다.</p>
            ) : (
              pending.slice(0, 3).map((item) => (
                <article className="pending-summary" key={item.id}>
                  <div>
                    <strong>{item.userName}</strong>
                    <span>{item.department}</span>
                  </div>
                  <p>{item.reason}</p>
                  <time dateTime={item.at}>{formatDateTime(item.at)}</time>
                </article>
              ))
            )}
          </div>
        </div>
      </section>

      <div className="dashboard-grid dashboard-grid--wide">
        <section className="admin-section" aria-labelledby="grade-heading">
          <div className="admin-section__heading">
            <div>
              <p className="admin-section__label">최근 요청</p>
              <h2 id="grade-heading">등급별 요청 분포</h2>
            </div>
            <span className="section-total"><strong>{totalRequests}</strong><span className="mono-fact">건</span></span>
          </div>

          {totalRequests === 0 ? (
            <p className="admin-empty">집계할 요청 기록이 없다.</p>
          ) : (
            <>
              <div
                className="grade-distribution"
                role="img"
                aria-label={gradeOrder.map((grade) => `${gradeLabels[grade]} ${summary.byGrade[grade]}건`).join(', ')}
              >
                {gradeOrder.map((grade) => {
                  const count = summary.byGrade[grade]
                  const width = (count / totalRequests) * 100
                  return count > 0 ? (
                    <span
                      className={`grade-distribution__segment grade-distribution__segment--${grade}`}
                      key={grade}
                      style={{ width: `${width}%` }}
                      title={`${count}건`}
                    />
                  ) : null
                })}
              </div>

              <ul className="grade-legend" aria-label="등급별 요청 건수">
                {gradeOrder.map((grade) => (
                  <li key={grade}>
                    <GradeBadge grade={grade} />
                    <strong>{summary.byGrade[grade]}</strong>
                    <span>건</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="admin-section" aria-labelledby="blocked-trend-heading">
          <div className="admin-section__heading">
            <div>
              <p className="admin-section__label">최근 14일</p>
              <h2 id="blocked-trend-heading">차단 건수 추이</h2>
            </div>
          </div>

          {summary.blockedTrend.length === 0 ? (
            <p className="admin-empty">표시할 차단 기록이 없다.</p>
          ) : (
            <div
              className="trend-chart"
              role="img"
              aria-label={summary.blockedTrend
                .map((point) => `${formatShortDate(point.date)} ${point.count}건`)
                .join(', ')}
            >
              {summary.blockedTrend.map((point, index) => {
                const height = point.count === 0 ? 2 : Math.max(8, (point.count / maxBlocked) * 100)
                return (
                  <div className="trend-chart__item" key={point.date}>
                    <span className="trend-chart__value">{point.count}</span>
                    <span
                      className="trend-chart__bar"
                      style={{ height: `${height}%` }}
                      title={`${formatShortDate(point.date)} ${point.count}건`}
                    />
                    <span className="trend-chart__date">
                      {index === 0 || index === summary.blockedTrend.length - 1 || index === 6
                        ? formatShortDate(point.date)
                        : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <div className="dashboard-grid dashboard-grid--lower">
        <section className="admin-section" aria-labelledby="detection-heading">
          <div className="admin-section__heading">
            <div>
              <p className="admin-section__label">유형별 누계</p>
              <h2 id="detection-heading">탐지 유형 분포</h2>
            </div>
          </div>

          {summary.byDetectionType.length === 0 ? (
            <p className="admin-empty">집계된 탐지 유형이 없다.</p>
          ) : (
            <ul className="detection-bars">
              {summary.byDetectionType.map((item) => (
                <li key={item.label}>
                  <span className="detection-bars__label">{item.label}</span>
                  <span className="detection-bars__track" aria-hidden="true">
                    <span style={{ width: `${(item.count / maxDetection) * 100}%` }} />
                  </span>
                  <strong>{item.count}</strong>
                  <span className="mono-fact">건</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="admin-section report-card" aria-labelledby="report-heading">
          <div>
            <p className="admin-section__label">사용자 피드백</p>
            <h2 id="report-heading">오탐 신고</h2>
            <p>사용자가 민감정보가 아니라고 알린 탐지 결과다.</p>
          </div>
          <div className="report-card__count">
            <strong>{summary.falsePositiveReports}</strong>
            <span className="mono-fact">건</span>
          </div>
        </section>
      </div>
    </div>
  )
}
