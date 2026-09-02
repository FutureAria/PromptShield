import type { Grade, Route } from '../api/types'

export const gradeLabels: Record<Grade, string> = {
  normal: '일반',
  caution: '주의',
  confidential: '기밀',
  blocked: '위험',
}

export const routeLabels: Record<Route, string> = {
  external_llm: '외부 LLM',
  internal_llm: '사내 LLM',
  masked_external: '마스킹 후 전달',
  blocked: '전송 차단',
}

export function GradeBadge({ grade, count }: { grade: Grade; count?: number }) {
  const countLabel = typeof count === 'number' ? ` · ${count}건` : ''

  return (
    <span className={`grade-badge grade-badge--${grade}`} aria-label={`민감도 ${gradeLabels[grade]}${countLabel}`}>
      <span className="grade-badge__dot" aria-hidden="true" />
      <span>{gradeLabels[grade]}</span>
      {typeof count === 'number' && <span className="mono">{count}건</span>}
    </span>
  )
}

export function RouteLabel({ route }: { route: Route }) {
  return <span className="route-label">{routeLabels[route]}</span>
}
