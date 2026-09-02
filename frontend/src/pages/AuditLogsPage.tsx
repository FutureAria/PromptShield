import { useEffect, useMemo, useState } from 'react'
import { getAuditLogs } from '../api'
import type { AuditLogEntry, Grade } from '../api/types'
import { GradeBadge, RouteLabel } from '../components/Status'

type GradeFilter = Grade | 'all'
type PeriodFilter = '7' | '14' | '30' | 'all'

function formatDateTime(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat('ko-KR', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([])
  const [grade, setGrade] = useState<GradeFilter>('all')
  const [period, setPeriod] = useState<PeriodFilter>('30')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      try {
        const entries = await getAuditLogs({})
        if (active) setLogs(entries)
      } catch {
        if (active) setError('감사 로그를 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [reloadKey])

  const filteredLogs = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('ko-KR')
    const cutoff = period === 'all'
      ? null
      : Date.now() - Number(period) * 24 * 60 * 60 * 1000

    return logs.filter((entry) => {
      if (grade !== 'all' && entry.grade !== grade) return false
      if (cutoff !== null && new Date(entry.at).getTime() < cutoff) return false
      if (!normalizedSearch) return true

      const searchable = [
        entry.userName,
        entry.department,
        entry.approvedBy ?? '',
        ...entry.detectionCounts.map((item) => item.label),
      ].join(' ').toLocaleLowerCase('ko-KR')
      return searchable.includes(normalizedSearch)
    })
  }, [grade, logs, period, search])

  return (
    <div className="admin-page">
      <header className="admin-page__header">
        <div>
          <p className="admin-page__eyebrow">요청 처리 기록</p>
          <h1>감사 로그</h1>
          <p>누가 언제 어떤 등급으로 처리했는지 확인한다.</p>
        </div>
        {!loading && !error ? (
          <span className="admin-result-count" aria-live="polite">
            <span className="mono-fact"><strong>{filteredLogs.length}</strong>건</span> 표시
          </span>
        ) : null}
      </header>

      <div className="privacy-notice" role="note">
        <span aria-hidden="true">—</span>
        <p><strong>원문은 기록·표시하지 않는다.</strong> 감사 로그에는 탐지 유형과 건수만 남긴다.</p>
      </div>

      <section className="log-filters" aria-label="감사 로그 필터">
        <label>
          <span>등급</span>
          <select value={grade} onChange={(event) => setGrade(event.target.value as GradeFilter)}>
            <option value="all">전체 등급</option>
            <option value="normal">일반</option>
            <option value="caution">주의</option>
            <option value="confidential">기밀</option>
            <option value="blocked">위험</option>
          </select>
        </label>

        <label>
          <span>기간</span>
          <select value={period} onChange={(event) => setPeriod(event.target.value as PeriodFilter)}>
            <option value="7">최근 7일</option>
            <option value="14">최근 14일</option>
            <option value="30">최근 30일</option>
            <option value="all">전체 기간</option>
          </select>
        </label>

        <label className="log-search">
          <span>검색</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="요청자·부서·탐지 유형"
          />
        </label>

        <button
          className="admin-button admin-button--quiet"
          type="button"
          onClick={() => {
            setGrade('all')
            setPeriod('30')
            setSearch('')
          }}
        >
          필터 지우기
        </button>
      </section>

      {loading ? (
        <section className="admin-status admin-status--inline" aria-live="polite">
          <span className="admin-spinner" aria-hidden="true" />
          <h2>감사 로그를 불러오는 중이다</h2>
          <p>입력 원문을 제외한 처리 기록만 확인하고 있다.</p>
        </section>
      ) : error ? (
        <section className="admin-status admin-status--inline" role="alert">
          <h2>감사 로그를 표시하지 못했다</h2>
          <p>{error}</p>
          <button className="admin-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
            다시 불러오기
          </button>
        </section>
      ) : filteredLogs.length === 0 ? (
        <section className="admin-empty admin-empty--panel">
          <h2>조건에 맞는 기록이 없다</h2>
          <p>등급이나 기간을 넓히거나 검색어를 바꿔 보세요.</p>
        </section>
      ) : (
        <div className="audit-table-wrap">
          <table className="audit-table">
            <caption className="visually-hidden">민감정보 원문을 제외한 요청 처리 감사 로그</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">요청자</th>
                <th scope="col">부서</th>
                <th scope="col">등급</th>
                <th scope="col">처리 경로</th>
                <th scope="col">탐지 유형별 건수</th>
                <th scope="col">승인자</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <time className="audit-time" dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                  </td>
                  <td>{entry.userName}</td>
                  <td>{entry.department}</td>
                  <td><GradeBadge grade={entry.grade} /></td>
                  <td><RouteLabel route={entry.route} /></td>
                  <td>
                    {entry.detectionCounts.length === 0 ? (
                      <span className="table-muted">탐지 없음</span>
                    ) : (
                      <ul className="detection-counts" aria-label="탐지 유형별 건수">
                        {entry.detectionCounts.map((item) => (
                          <li key={item.label}>
                            <span>{item.label}</span>
                            <strong>{item.count}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>{entry.approvedBy ?? <span className="table-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
