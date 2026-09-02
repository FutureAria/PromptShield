import type { Detection, InspectionResult } from '../api/types'

export type InspectionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'detection'; text: string; detection: Detection }

interface IndexedDetection {
  detection: Detection
  index: number
}

/**
 * 원문을 화면에 표시할 순서대로 나눈다.
 *
 * 탐지 배열의 순서와 무관하게 앞쪽 문자 오프셋을 우선한다. 같은 위치에서
 * 시작하는 항목은 API가 먼저 보낸 항목을 유지하고, 이미 채택한 구간과
 * 겹치는 항목은 통째로 버린다.
 */
export function buildInspectionSegments(
  originalText: string,
  detections: Detection[],
): InspectionSegment[] {
  const ordered: IndexedDetection[] = detections
    .map((detection, index) => ({ detection, index }))
    .filter(({ detection }) => {
      return (
        Number.isInteger(detection.start) &&
        Number.isInteger(detection.end) &&
        detection.start >= 0 &&
        detection.end > detection.start &&
        detection.end <= originalText.length
      )
    })
    .sort((a, b) => {
      return a.detection.start - b.detection.start || a.index - b.index
    })

  const segments: InspectionSegment[] = []
  let cursor = 0

  ordered.forEach(({ detection }) => {
    if (detection.start < cursor) return

    if (detection.start > cursor) {
      segments.push({
        kind: 'text',
        text: originalText.slice(cursor, detection.start),
      })
    }

    segments.push({
      kind: 'detection',
      text: originalText.slice(detection.start, detection.end),
      detection,
    })
    cursor = detection.end
  })

  if (cursor < originalText.length) {
    segments.push({ kind: 'text', text: originalText.slice(cursor) })
  }

  return segments
}

interface InspectionComparisonProps {
  result: InspectionResult
  reportedDetectionIds?: ReadonlySet<string>
  reportingDetectionIds?: ReadonlySet<string>
  onReportFalsePositive?: (detection: Detection) => void
}

const noDetectionIds = new Set<string>()

export function InspectionComparison({
  result,
  reportedDetectionIds = noDetectionIds,
  reportingDetectionIds = noDetectionIds,
  onReportFalsePositive = () => undefined,
}: InspectionComparisonProps) {
  if (result.detections.length === 0) {
    return (
      <p className="comparison-empty" role="status">
        탐지된 민감정보가 없다
      </p>
    )
  }

  const segments = buildInspectionSegments(result.originalText, result.detections)
  const acceptedDetections = segments.filter(
    (segment): segment is Extract<InspectionSegment, { kind: 'detection' }> =>
      segment.kind === 'detection',
  )
  const originalLabelId = `original-label-${result.requestId}`
  const transmissionLabelId = `transmission-label-${result.requestId}`

  return (
    <div className="comparison-wrap">
      <div className="comparison" aria-label="원문과 전송본 대조">
        <section className="comparison__section" aria-labelledby={originalLabelId}>
          <div className="comparison__label" id={originalLabelId}>
            원문
          </div>
          <p className="comparison__text comparison__text--original">
            {segments.map((segment, index) => {
              if (segment.kind === 'text') {
                return <span key={`text-${index}`}>{segment.text}</span>
              }

              const { detection } = segment
              const tooltipId = `detection-tooltip-${result.requestId}-${detection.id}`

              return (
                <mark
                  aria-describedby={tooltipId}
                  aria-label={`${detection.label}, 문자 오프셋 ${detection.start}부터 ${detection.end}`}
                  className={`comparison__mark comparison__mark--${result.grade}`}
                  key={detection.id}
                  tabIndex={0}
                >
                  {segment.text}
                  <span
                    className="comparison__tooltip"
                    id={tooltipId}
                    role="tooltip"
                  >
                    <span>{detection.label}</span>
                    <code>
                      {detection.start}:{detection.end}
                    </code>
                  </span>
                </mark>
              )
            })}
          </p>
        </section>

        <section className="comparison__section" aria-labelledby={transmissionLabelId}>
          <div className="comparison__label" id={transmissionLabelId}>
            전송본
          </div>
          <p
            aria-label="전송본"
            className="comparison__text comparison__text--transmission"
          >
            {segments.map((segment, index) => {
              if (segment.kind === 'text') {
                return <span key={`masked-text-${index}`}>{segment.text}</span>
              }

              return (
                <code className="comparison__token" key={`masked-${segment.detection.id}`}>
                  {segment.detection.masked}
                </code>
              )
            })}
          </p>
        </section>
      </div>

      <section className="detections" aria-labelledby="detections-heading">
        <div className="detections__heading" id="detections-heading">
          <span>탐지 항목</span>
          <span className="mono">{acceptedDetections.length}건</span>
        </div>
        <ul className="detections__list">
          {acceptedDetections.map(({ detection }) => {
            const reported = reportedDetectionIds.has(detection.id)
            const reporting = reportingDetectionIds.has(detection.id)

            return (
              <li className="detections__item" key={detection.id}>
                <div className="detections__fact">
                  <span className="detections__name">{detection.label}</span>
                  <code className="detections__offset">
                    {detection.start}:{detection.end}
                  </code>
                  <code className="detections__replacement">{detection.masked}</code>
                </div>
                {reported ? (
                  <span className="detections__reported" role="status">
                    신고 접수
                  </span>
                ) : (
                  <button
                    className="text-button"
                    disabled={reporting}
                    onClick={() => onReportFalsePositive(detection)}
                    type="button"
                  >
                    {reporting ? '접수 중' : '오탐 신고'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
