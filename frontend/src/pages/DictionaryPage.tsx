import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DictionaryValidationError,
  checkDictionaryDraft,
  dictionaryPresets,
  getDictionary,
  getGradePolicy,
  parseDictionaryPaste,
  previewInspection,
  saveDictionary,
} from '../api'
import type {
  DictionaryDraftCheck,
  DictionaryDraftEntry,
  DictionaryEntry,
  DictionaryEntryType,
  DictionaryGrade,
  DictionaryIssue,
  DictionaryPreview,
  DictionarySnapshot,
  GradePolicyRow,
} from '../api/types'
import { useSession } from '../auth/SessionContext'
// InspectionComparison의 전역 스타일은 App이 정적 import하는 employee.css에서 로드된다.
import { InspectionComparison } from '../components/InspectionComparison'
import { GradeBadge, RouteLabel, gradeLabels } from '../components/Status'

const entryTypeOrder: readonly DictionaryEntryType[] = [
  'partner',
  'product_code',
  'price_expression',
  'other',
]

const gradeOrder: readonly DictionaryGrade[] = ['caution', 'confidential']

const previewExamples = [
  {
    label: 'G-02 안내문',
    text: '홍길동 010-0000-0000 hong@example.com 으로 안내문 보내줘',
  },
  {
    label: 'G-03 견적',
    text: 'ABC상사 X-100 단가 12,000원 견적 문구 만들어줘',
  },
  {
    label: '정상 업무 문장',
    text: '회의록 요약 양식을 알려줘',
  },
] as const

type PastePreview = ReturnType<typeof parseDictionaryPaste>
type DraftRowState = 'unchanged' | 'edited' | 'new' | 'deactivated'

interface CurrentDraftCheck {
  version: number
  result: DictionaryDraftCheck
}

interface CurrentPreview {
  draftVersion: number
  text: string
  result: DictionaryPreview
}

function toDraft(entries: readonly DictionaryEntry[]): DictionaryDraftEntry[] {
  return entries.map((entry) => ({
    rowId: entry.id,
    id: entry.id,
    term: entry.term,
    entryType: entry.entryType,
    grade: entry.grade,
    active: entry.active,
    note: entry.note,
  }))
}

function rowChanged(row: DictionaryDraftEntry, saved: DictionaryEntry | undefined): boolean {
  if (!saved) return true
  return row.term !== saved.term
    || row.entryType !== saved.entryType
    || row.grade !== saved.grade
    || row.active !== saved.active
    || row.note !== saved.note
}

function getRowState(row: DictionaryDraftEntry, saved: DictionaryEntry | undefined): DraftRowState {
  if (!row.id) return 'new'
  if (saved?.active && !row.active) return 'deactivated'
  return rowChanged(row, saved) ? 'edited' : 'unchanged'
}

function formatShortDateTime(value: string): string {
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function issueId(rowId: string, field: 'term' | 'note', compact = false): string {
  return `dict-issue-${compact ? 'compact-' : ''}${field}-${rowId}`
}

function rowMarker(state: DraftRowState) {
  if (state === 'unchanged') return null

  const marker = state === 'new' ? '+' : state === 'deactivated' ? '−' : '•'
  const label = state === 'new' ? '새 항목' : state === 'deactivated' ? '비활성화됨' : '수정됨'
  return (
    <span className={`dict-change-marker dict-change-marker--${state}`} aria-label={label}>
      {marker}
    </span>
  )
}

function RowIssues({
  issues,
  id,
}: {
  issues: readonly DictionaryIssue[]
  id: string
}) {
  if (issues.length === 0) return null
  const hasError = issues.some((issue) => issue.level === 'error')
  return (
    <div className="dict-row-issue" id={id} role={hasError ? 'alert' : 'note'}>
      {issues.map((issue) => <p key={`${issue.code}-${issue.message}`}>{issue.message}</p>)}
    </div>
  )
}

function FieldValue({ value }: { value: string }) {
  return value ? <span>{value}</span> : <span className="table-muted">—</span>
}

function DictionaryRows({
  rows,
  savedById,
  issues,
  falsePositiveHits,
  canEdit,
  saving,
  inactive = false,
  onChange,
  onDeactivate,
  onReactivate,
  onRemove,
  onGradeTouched,
  registerTermInput,
}: {
  rows: readonly DictionaryDraftEntry[]
  savedById: ReadonlyMap<string, DictionaryEntry>
  issues: readonly DictionaryIssue[]
  falsePositiveHits: DictionaryDraftCheck['falsePositiveHits']
  canEdit: boolean
  saving: boolean
  inactive?: boolean
  onChange: (rowId: string, patch: Partial<DictionaryDraftEntry>) => void
  onDeactivate: (rowId: string) => void
  onReactivate: (rowId: string) => void
  onRemove: (rowId: string) => void
  onGradeTouched: (rowId: string) => void
  registerTermInput: (rowId: string, element: HTMLInputElement | null) => void
}) {
  const columnCount = canEdit ? 7 : 6

  return (
    <div className="dict-table-wrap">
      <table className="audit-table dict-table">
        <caption className="visually-hidden">
          {inactive ? '현재 탐지에 쓰지 않는 비활성 사전 항목' : '현재 탐지에 쓰는 활성 사전 항목'}
        </caption>
        <thead>
          <tr>
            <th scope="col"><span className="visually-hidden">변경 상태</span></th>
            <th scope="col">용어</th>
            <th scope="col">유형</th>
            <th scope="col">등급</th>
            <th className="dict-note-column" scope="col">메모</th>
            <th className="dict-updated-column" scope="col">수정</th>
            {canEdit ? <th scope="col"><span className="visually-hidden">조작</span></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columnCount}>
                <p className="admin-empty dict-table-empty">
                  {inactive ? '비활성 항목이 없다.' : '활성 항목이 없다. 필요한 용어를 행으로 추가한다.'}
                </p>
              </td>
            </tr>
          ) : rows.map((row, visibleIndex) => {
            const rowLabel = inactive ? `비활성 ${visibleIndex + 1}행` : `${visibleIndex + 1}행`
            const saved = row.id ? savedById.get(row.id) : undefined
            const state = getRowState(row, saved)
            const termIssues = issues.filter((issue) => issue.rowId === row.rowId && issue.field === 'term')
            const noteIssues = issues.filter((issue) => issue.rowId === row.rowId && issue.field === 'note')
            const termError = termIssues.some((issue) => issue.level === 'error')
            const noteError = noteIssues.some((issue) => issue.level === 'error')
            const hits = falsePositiveHits.filter((hit) => hit.rowId === row.rowId)
            const termDescribedBy = [
              termIssues.length > 0 ? issueId(row.rowId, 'term') : '',
              hits.length > 0 ? `dict-probe-${row.rowId}` : '',
            ].filter(Boolean).join(' ') || undefined

            return (
              <tr className={`dict-table__row dict-table__row--${state}`} key={row.rowId}>
                <td className="dict-table__marker">{rowMarker(state)}</td>
                <td className="dict-table__term">
                  {canEdit ? (
                    <input
                      aria-describedby={termDescribedBy}
                      aria-invalid={termError || undefined}
                      aria-label={`${rowLabel} 용어`}
                      disabled={saving}
                      ref={(element) => registerTermInput(row.rowId, element)}
                      type="text"
                      value={row.term}
                      onChange={(event) => onChange(row.rowId, { term: event.target.value })}
                    />
                  ) : <FieldValue value={row.term} />}
                  <RowIssues id={issueId(row.rowId, 'term')} issues={termIssues} />
                  {hits.length > 0 ? (
                    <div className="dict-row-issue dict-row-probe" id={`dict-probe-${row.rowId}`} role="note">
                      {hits.map((hit) => (
                        <p key={`${hit.sentence}-${hit.matched}`}>정상 업무 문장 “{hit.sentence}”에서 걸린다.</p>
                      ))}
                    </div>
                  ) : null}
                  <div className="dict-mobile-note" data-label="메모">
                    {canEdit ? (
                      <input
                        aria-describedby={noteIssues.length > 0 ? issueId(row.rowId, 'note', true) : undefined}
                        aria-invalid={noteError || undefined}
                        aria-label={`${rowLabel} 메모`}
                        disabled={saving}
                        maxLength={100}
                        type="text"
                        value={row.note}
                        onChange={(event) => onChange(row.rowId, { note: event.target.value })}
                      />
                    ) : <FieldValue value={row.note} />}
                    <RowIssues id={issueId(row.rowId, 'note', true)} issues={noteIssues} />
                  </div>
                </td>
                <td>
                  {canEdit ? (
                    <select
                      aria-label={`${rowLabel} 유형`}
                      disabled={saving}
                      value={row.entryType}
                      onChange={(event) => {
                        const entryType = event.target.value as DictionaryEntryType
                        onChange(row.rowId, { entryType })
                      }}
                    >
                      {entryTypeOrder.map((entryType) => (
                        <option key={entryType} value={entryType}>{dictionaryPresets[entryType].typeLabel}</option>
                      ))}
                    </select>
                  ) : <span>{dictionaryPresets[row.entryType].typeLabel}</span>}
                </td>
                <td>
                  {canEdit ? (
                    <select
                      aria-label={`${rowLabel} 등급`}
                      disabled={saving}
                      value={row.grade}
                      onChange={(event) => {
                        onGradeTouched(row.rowId)
                        onChange(row.rowId, { grade: event.target.value as DictionaryGrade })
                      }}
                    >
                      {gradeOrder.map((grade) => <option key={grade} value={grade}>{gradeLabels[grade]}</option>)}
                    </select>
                  ) : <GradeBadge grade={row.grade} />}
                </td>
                <td className="dict-note-column">
                  {canEdit ? (
                    <input
                      aria-describedby={noteIssues.length > 0 ? issueId(row.rowId, 'note') : undefined}
                      aria-invalid={noteError || undefined}
                      aria-label={`${rowLabel} 메모`}
                      disabled={saving}
                      maxLength={100}
                      type="text"
                      value={row.note}
                      onChange={(event) => onChange(row.rowId, { note: event.target.value })}
                    />
                  ) : <FieldValue value={row.note} />}
                  <RowIssues id={issueId(row.rowId, 'note')} issues={noteIssues} />
                </td>
                <td className="dict-updated-column">
                  {saved ? (
                    <span className="dict-updated">
                      <time className="audit-time" dateTime={saved.updatedAt}>{formatShortDateTime(saved.updatedAt)}</time>
                      <small>{saved.updatedBy}</small>
                    </span>
                  ) : <span className="table-muted">저장 전</span>}
                </td>
                {canEdit ? (
                  <td className="dict-table__action">
                    {!row.id ? (
                      <button
                        className="admin-button admin-button--quiet"
                        disabled={saving}
                        type="button"
                        onClick={() => onRemove(row.rowId)}
                      >
                        제거
                      </button>
                    ) : inactive ? (
                      <button
                        className="admin-button admin-button--quiet"
                        disabled={saving}
                        type="button"
                        onClick={() => onReactivate(row.rowId)}
                      >
                        다시 활성화
                      </button>
                    ) : (
                      <button
                        className="admin-button admin-button--quiet"
                        disabled={saving}
                        type="button"
                        onClick={() => onDeactivate(row.rowId)}
                      >
                        비활성화
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PolicyTable({ rows }: { rows: readonly GradePolicyRow[] }) {
  return (
    <div className="audit-table-wrap">
      <table className="audit-table dict-policy-table">
        <caption className="visually-hidden">등급별 처리 경로와 직원 화면 동작</caption>
        <thead>
          <tr>
            <th scope="col">등급</th>
            <th scope="col">처리 경로</th>
            <th scope="col">직원 화면에서 일어나는 일</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.grade}>
              <td><GradeBadge grade={row.grade} /></td>
              <td><RouteLabel route={row.route} /></td>
              <td>{row.employeeAction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DictionaryPage() {
  const { session } = useSession()
  const canEdit = session?.role === 'approver'
  const [snapshot, setSnapshot] = useState<DictionarySnapshot | null>(null)
  const [draft, setDraft] = useState<DictionaryDraftEntry[]>([])
  const [draftVersion, setDraftVersion] = useState(0)
  const [draftCheck, setDraftCheck] = useState<CurrentDraftCheck | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [toast, setToast] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [pasteDefaultType, setPasteDefaultType] = useState<DictionaryEntryType>('partner')
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null)
  const [pasteStatus, setPasteStatus] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [preview, setPreview] = useState<CurrentPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const nextRowSequence = useRef(0)
  const gradeTouchedRows = useRef(new Set<string>())
  const termInputs = useRef(new Map<string, HTMLInputElement>())
  const pendingFocusRow = useRef<string | null>(null)
  const inactiveDetails = useRef<HTMLDetailsElement | null>(null)
  const toastTimer = useRef<number | null>(null)
  const policyRows = useMemo(() => getGradePolicy(), [])

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setLoadError('')
      try {
        const nextSnapshot = await getDictionary()
        if (!active) return
        setSnapshot(nextSnapshot)
        setDraft(toDraft(nextSnapshot.entries))
        setDraftVersion((version) => version + 1)
        setDraftCheck(null)
        setSaveError('')
        setConflict(false)
        setPastePreview(null)
        setPasteStatus('')
        setPreview(null)
        setPreviewError('')
        gradeTouchedRows.current.clear()
      } catch {
        if (active) setLoadError('기업 사전을 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [reloadKey])

  useEffect(() => {
    if (!snapshot) return
    let active = true
    setDraftCheck(null)
    const checkedVersion = draftVersion
    const timer = window.setTimeout(() => {
      void checkDictionaryDraft(draft).then((result) => {
        if (active) setDraftCheck({ version: checkedVersion, result })
      }).catch(() => {
        // 자동 검사 실패는 저장 시 API 검증으로 다시 차단한다.
      })
    }, 400)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [draft, draftVersion, snapshot])

  useEffect(() => {
    const rowId = pendingFocusRow.current
    if (!rowId) return
    const input = termInputs.current.get(rowId)
    if (!input) return
    pendingFocusRow.current = null
    input.focus()
  }, [draft])

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
  }, [])

  const savedById = useMemo(
    () => new Map((snapshot?.entries ?? []).map((entry) => [entry.id, entry])),
    [snapshot],
  )
  const activeRows = useMemo(() => draft.filter((row) => row.active), [draft])
  const inactiveRows = useMemo(() => draft.filter((row) => !row.active), [draft])
  const changedCount = useMemo(
    () => draft.filter((row) => rowChanged(row, row.id ? savedById.get(row.id) : undefined)).length,
    [draft, savedById],
  )
  const dirty = changedCount > 0
  const currentCheck = draftCheck?.version === draftVersion ? draftCheck.result : null
  const issues = currentCheck?.issues ?? []
  const falsePositiveHits = currentCheck?.falsePositiveHits ?? []
  const errorCount = issues.filter((issue) => issue.level === 'error').length
  const warningCount = issues.filter((issue) => issue.level === 'warning').length
  const totalIssues = issues.filter((issue) => issue.rowId === 'total')
  const removedDeltaCount = preview && preview.draftVersion === draftVersion
    ? preview.result.deltas.filter((delta) => delta.kind === 'removed').length
    : 0
  const previewIsStale = Boolean(preview && (
    (canEdit && preview.draftVersion !== draftVersion) || preview.text !== previewText
  ))

  function showToast(message: string) {
    setToast(message)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3600)
  }

  function markDraftChanged(next: DictionaryDraftEntry[]) {
    setDraft(next)
    setDraftVersion((version) => version + 1)
    if (!conflict) setSaveError('')
    setToast('')
    setPasteStatus('')
  }

  function updateRow(rowId: string, patch: Partial<DictionaryDraftEntry>) {
    markDraftChanged(draft.map((row) => {
      if (row.rowId !== rowId) return row
      if (patch.entryType && patch.entryType !== row.entryType && !gradeTouchedRows.current.has(rowId)) {
        return {
          ...row,
          ...patch,
          grade: dictionaryPresets[patch.entryType].defaultGrade,
        }
      }
      return { ...row, ...patch }
    }))
  }

  function registerTermInput(rowId: string, element: HTMLInputElement | null) {
    if (element) termInputs.current.set(rowId, element)
    else termInputs.current.delete(rowId)
  }

  function addRow() {
    nextRowSequence.current += 1
    const rowId = `new-${Date.now().toString(36)}-${nextRowSequence.current}`
    pendingFocusRow.current = rowId
    markDraftChanged([
      ...draft,
      {
        rowId,
        term: '',
        entryType: 'partner',
        grade: dictionaryPresets.partner.defaultGrade,
        active: true,
        note: '',
      },
    ])
  }

  function removeRow(rowId: string) {
    gradeTouchedRows.current.delete(rowId)
    markDraftChanged(draft.filter((row) => row.rowId !== rowId || row.id))
  }

  function resetDraft() {
    if (!snapshot) return
    gradeTouchedRows.current.clear()
    markDraftChanged(toDraft(snapshot.entries))
    setSaveError(conflict ? saveError : '')
  }

  function focusFirstError(nextIssues: readonly DictionaryIssue[]) {
    const rowIssue = nextIssues.find((issue) => issue.level === 'error' && issue.rowId !== 'total')
    const fallbackRow = draft[0]
    const rowId = rowIssue?.rowId ?? fallbackRow?.rowId ?? ''
    if (draft.find((row) => row.rowId === rowId)?.active === false && inactiveDetails.current) {
      inactiveDetails.current.open = true
    }
    window.requestAnimationFrame(() => termInputs.current.get(rowId)?.focus())
  }

  async function handleSave() {
    if (!snapshot || !dirty || conflict) return
    if (errorCount > 0) {
      focusFirstError(issues)
      return
    }

    setSaving(true)
    setSaveError('')
    try {
      const nextSnapshot = await saveDictionary({
        baseRevision: snapshot.revision,
        entries: draft,
      })
      setSnapshot(nextSnapshot)
      setDraft(toDraft(nextSnapshot.entries))
      setDraftVersion((version) => version + 1)
      setDraftCheck(null)
      setPreview(null)
      setConflict(false)
      gradeTouchedRows.current.clear()
      showToast('사전을 저장했다. 지금부터 직원 화면 검사에 반영된다.')
    } catch (error) {
      if (error instanceof DictionaryValidationError) {
        try {
          const checked = await checkDictionaryDraft(draft)
          setDraftCheck({ version: draftVersion, result: checked })
          focusFirstError(checked.issues)
        } catch {
          setDraftCheck({
            version: draftVersion,
            result: {
              issues: error.issues,
              falsePositiveHits: [],
              activeCount: activeRows.length,
              activeLimit: snapshot.activeLimit,
            },
          })
          focusFirstError(error.issues)
        }
      } else if (error instanceof Error && error.message.startsWith('다른 관리자가 사전을 먼저 저장했다.')) {
        setConflict(true)
        setSaveError(error.message)
      } else {
        setSaveError('사전을 저장하지 못했다. 잠시 후 다시 시도해 주세요.')
      }
    } finally {
      setSaving(false)
    }
  }

  function applyPastePreview() {
    if (!pastePreview) return
    let next = [...draft]
    let newSequence = nextRowSequence.current

    for (const parsed of pastePreview.rows) {
      if (parsed.verdict === 'new') {
        newSequence += 1
        next.push({
          rowId: `paste-${Date.now().toString(36)}-${newSequence}`,
          term: parsed.term,
          entryType: parsed.entryType,
          grade: parsed.grade,
          active: true,
          note: parsed.note,
        })
      } else if (parsed.verdict === 'changed') {
        const index = next.findIndex((row) => row.term === parsed.term)
        if (index >= 0) {
          next[index] = {
            ...next[index],
            entryType: parsed.entryType,
            grade: parsed.grade,
            note: parsed.note,
          }
        }
      }
    }

    nextRowSequence.current = newSequence
    markDraftChanged(next)
    const { added, changed } = pastePreview.summary
    setPasteStatus(`신규 ${added}건과 덮어쓰기 ${changed}건을 초안에 반영했다. 저장해야 실제 검사에 적용된다.`)
    setPastePreview(null)
    setPasteText('')
  }

  async function runPreview() {
    if (!previewText.trim()) return
    setPreviewing(true)
    setPreviewError('')
    const checkedVersion = draftVersion
    const checkedText = previewText
    try {
      const result = canEdit
        ? await previewInspection(checkedText, draft)
        : await previewInspection(checkedText)
      setPreview({ draftVersion: checkedVersion, text: checkedText, result })
    } catch {
      setPreviewError('시험 검사를 완료하지 못했다. 잠시 후 다시 시도해 주세요.')
    } finally {
      setPreviewing(false)
    }
  }

  if (loading) {
    return (
      <section className="admin-status" aria-live="polite">
        <span className="admin-spinner" aria-hidden="true" />
        <h1>기업 사전을 불러오는 중이다</h1>
        <p>현재 탐지에 쓰는 용어와 등급을 확인하고 있다.</p>
      </section>
    )
  }

  if (loadError || !snapshot) {
    return (
      <section className="admin-status" role="alert">
        <h1>기업 사전을 표시하지 못했다</h1>
        <p>{loadError || '알 수 없는 오류가 발생했다.'}</p>
        <button className="admin-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
          다시 불러오기
        </button>
      </section>
    )
  }

  const addedDeltas = preview?.result.deltas.filter((delta) => delta.kind === 'added') ?? []
  const removedDeltas = preview?.result.deltas.filter((delta) => delta.kind === 'removed') ?? []
  const relabeledDeltas = preview?.result.deltas.filter((delta) => delta.kind === 'relabeled') ?? []
  const netDetectionDelta = preview
    ? preview.result.draft.detections.length - preview.result.saved.detections.length
    : 0

  return (
    <div className="admin-page dict-page">
      <header className="admin-page__header">
        <div>
          <p className="admin-page__eyebrow">탐지 기준 관리</p>
          <h1>기업 사전</h1>
          <p>회사 고유 용어를 관리하고 저장 전에 탐지 영향을 확인한다.</p>
        </div>
        {canEdit ? (
          <span className="admin-result-count" aria-live="polite">
            활성 <span className="mono-fact"><strong>{activeRows.length}</strong>건</span>
            {' / '}상한 <span className="mono-fact"><strong>{snapshot.activeLimit}</strong>건</span>
          </span>
        ) : (
          <p className="dict-readonly">조회 전용 — 사전 수정은 승인자가 한다.</p>
        )}
      </header>

      <div className="privacy-notice" role="note">
        <span aria-hidden="true">—</span>
        <p><strong>사전에는 사람 이름과 개인 식별 정보를 넣지 않는다.</strong> 이름·연락처 탐지는 별도 규칙이 담당한다.</p>
      </div>

      {canEdit ? (
        <section className="dict-save-bar" aria-label="사전 저장 상태">
          <div className="dict-save-bar__state" aria-live="polite">
            <strong>{dirty ? `변경 ${changedCount}건 · 저장되지 않음` : '저장된 상태'}</strong>
            <div className="dict-save-bar__messages" id="dict-save-guidance">
              {errorCount > 0 ? <span>고칠 곳 {errorCount}건</span> : null}
              {warningCount > 0 ? <span>확인할 경고 {warningCount}건</span> : null}
              {falsePositiveHits.length > 0 ? <span>정상 문장에서 {falsePositiveHits.length}건이 걸린다</span> : null}
              {removedDeltaCount > 0 ? <strong>미탐 {removedDeltaCount}건</strong> : null}
            </div>
          </div>
          {saveError ? <p className="action-error dict-save-bar__error" role="alert">{saveError}</p> : null}
          <div className="dict-save-bar__actions">
            {conflict ? (
              <button className="admin-button" type="button" onClick={() => setReloadKey((value) => value + 1)}>
                최신 불러오기
              </button>
            ) : null}
            <button
              className="admin-button admin-button--quiet"
              disabled={!dirty || saving}
              type="button"
              onClick={resetDraft}
            >
              초안 되돌리기
            </button>
            <button
              aria-describedby="dict-save-guidance"
              className="admin-button"
              disabled={!dirty || saving || conflict || errorCount > 0}
              type="button"
              onClick={() => void handleSave()}
            >
              {saving ? '저장 중' : '저장'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="admin-section dict-section" aria-labelledby="dictionary-active-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">1</p>
            <h2 id="dictionary-active-heading">사전 항목</h2>
          </div>
          {canEdit ? (
            <button className="admin-button admin-button--quiet" disabled={saving} type="button" onClick={addRow}>
              행 추가
            </button>
          ) : null}
        </div>

        {totalIssues.length > 0 ? (
          <div className="dict-total-issue" role="alert">
            {totalIssues.map((issue) => <p key={issue.code}>{issue.message}</p>)}
          </div>
        ) : null}

        <DictionaryRows
          canEdit={canEdit}
          falsePositiveHits={falsePositiveHits}
          inactive={false}
          issues={issues}
          rows={activeRows}
          savedById={savedById}
          saving={saving}
          onChange={updateRow}
          onDeactivate={(rowId) => updateRow(rowId, { active: false })}
          onGradeTouched={(rowId) => gradeTouchedRows.current.add(rowId)}
          onReactivate={(rowId) => updateRow(rowId, { active: true })}
          onRemove={removeRow}
          registerTermInput={registerTermInput}
        />

        <p className="dict-limit-note">
          사전은 <strong>적은 그대로 일치하는 문자열</strong>만 잡는다. 띄어쓰기·전각 문자·대소문자 같은 표기 변형은 별개 항목으로 등록하거나 정규화 규칙에서 다룬다.
        </p>
      </section>

      {canEdit ? (
        <details className="admin-section dict-details">
          <summary className="dict-details__summary">2. 엑셀에서 가져오기</summary>
          <div className="dict-details__body">
            <div className="dict-paste-controls">
              <label>
                <span>기본 유형</span>
                <select
                  disabled={saving}
                  value={pasteDefaultType}
                  onChange={(event) => {
                    setPasteDefaultType(event.target.value as DictionaryEntryType)
                    setPastePreview(null)
                    setPasteStatus('')
                  }}
                >
                  {entryTypeOrder.map((entryType) => (
                    <option key={entryType} value={entryType}>{dictionaryPresets[entryType].typeLabel}</option>
                  ))}
                </select>
              </label>
              <label className="dict-paste-input">
                <span>엑셀에서 복사한 내용</span>
                <textarea
                  disabled={saving}
                  placeholder={'용어\t유형\t등급\t메모'}
                  rows={6}
                  value={pasteText}
                  onChange={(event) => {
                    setPasteText(event.target.value)
                    setPastePreview(null)
                    setPasteStatus('')
                  }}
                />
              </label>
              <div className="dict-paste-actions">
                <button
                  className="admin-button"
                  disabled={saving || !pasteText.trim()}
                  type="button"
                  onClick={() => {
                    setPastePreview(parseDictionaryPaste(pasteText, draft, pasteDefaultType))
                    setPasteStatus('')
                  }}
                >
                  불러오기
                </button>
              </div>
            </div>

            {pasteStatus ? <p className="dict-paste-status" role="status">{pasteStatus}</p> : null}

            {pastePreview ? (
              <div className="dict-paste-preview">
                <p className="dict-paste-summary" aria-live="polite">
                  신규 <span className="mono-fact">{pastePreview.summary.added}</span>
                  {' · '}덮어쓰기 <span className="mono-fact">{pastePreview.summary.changed}</span>
                  {' · '}건너뜀 <span className="mono-fact">{pastePreview.summary.same}</span>
                  {' · '}오류 <span className="mono-fact">{pastePreview.summary.error}</span>
                </p>
                {pastePreview.truncated ? <p className="dict-paste-notice">200행까지만 읽었다. 나머지는 다시 붙여 넣는다.</p> : null}
                {pastePreview.extraColumns ? <p className="dict-paste-notice">열이 더 있어 앞 4열만 읽었다.</p> : null}
                <div className="audit-table-wrap">
                  <table className="audit-table dict-paste-table">
                    <caption className="visually-hidden">붙여넣은 사전 항목의 초안 반영 전 미리보기</caption>
                    <thead>
                      <tr>
                        <th scope="col">원본 줄</th>
                        <th scope="col">용어</th>
                        <th scope="col">유형</th>
                        <th scope="col">등급</th>
                        <th scope="col">메모</th>
                        <th scope="col">판정</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pastePreview.rows.map((row) => {
                        const verdict = row.verdict === 'new'
                          ? '신규'
                          : row.verdict === 'same'
                            ? '동일 — 건너뜀'
                            : row.verdict === 'changed'
                              ? '값 다름 — 덮어쓰기'
                              : '오류 — 제외'
                        return (
                          <tr key={`${row.lineNumber}-${row.term}`}>
                            <td><span className="mono-fact">{row.lineNumber}</span></td>
                            <td><FieldValue value={row.term} /></td>
                            <td>{dictionaryPresets[row.entryType].typeLabel}</td>
                            <td>{gradeLabels[row.grade]}</td>
                            <td><FieldValue value={row.note} /></td>
                            <td>
                              <strong>{verdict}</strong>
                              {row.errorMessage ? <p className="dict-row-issue">{row.errorMessage}</p> : null}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="dict-paste-actions">
                  <button
                    className="admin-button"
                    disabled={saving || pastePreview.summary.added + pastePreview.summary.changed === 0}
                    type="button"
                    onClick={applyPastePreview}
                  >
                    초안에 반영
                  </button>
                  <button
                    className="admin-button admin-button--quiet"
                    disabled={saving}
                    type="button"
                    onClick={() => setPastePreview(null)}
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : null}

            <p className="dict-limit-note">
              사전은 <strong>적은 그대로 일치하는 문자열</strong>만 잡는다. 띄어쓰기·전각 문자·대소문자 같은 표기 변형은 별개 항목으로 등록하거나 정규화 규칙에서 다룬다.
            </p>
          </div>
        </details>
      ) : null}

      <section className="admin-section dict-section" aria-labelledby="dictionary-preview-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">3</p>
            <h2 id="dictionary-preview-heading">저장 전 시험 검사</h2>
          </div>
        </div>

        <div className="dict-preview-form">
          <label className="dict-preview-form__field">
            <span>시험 문장</span>
            <input
              type="text"
              value={previewText}
              onChange={(event) => {
                setPreviewText(event.target.value)
                setPreviewError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && previewText.trim() && !previewing) void runPreview()
              }}
            />
          </label>
          <div className="dict-preview-examples" aria-label="시험 문장 예문">
            <span>예문:</span>
            {previewExamples.map((example) => (
              <button
                className="admin-button admin-button--quiet"
                key={example.label}
                type="button"
                onClick={() => {
                  setPreviewText(example.text)
                  setPreviewError('')
                }}
              >
                {example.label}
              </button>
            ))}
          </div>
          <p className="dict-preview-privacy">시험 문장에 실제 민감정보를 넣지 않는다. 이 입력은 어디에도 기록하지 않는다.</p>
          <div className="dict-preview-form__actions">
            <button
              className="admin-button"
              disabled={!previewText.trim() || previewing}
              type="button"
              onClick={() => void runPreview()}
            >
              {previewing ? '검사 중' : '시험 검사'}
            </button>
          </div>
        </div>

        {previewError ? <p className="action-error" role="alert">{previewError}</p> : null}

        {preview ? (
          <div className={`dict-preview-result${previewIsStale ? ' dict-preview-result--stale' : ''}`}>
            {previewIsStale ? (
              <p className="dict-preview-stale" role="status">
                {canEdit && preview.draftVersion !== draftVersion
                  ? '초안이 바뀌었다. 다시 검사한다.'
                  : '시험 문장이 바뀌었다. 다시 검사한다.'}
              </p>
            ) : null}

            <div className="dict-preview-summary" aria-label="시험 검사 등급 비교">
              {canEdit ? (
                <>
                  <div className="dict-preview-summary__row">
                    <strong>저장된 사전</strong>
                    <GradeBadge grade={preview.result.saved.grade} />
                    <RouteLabel route={preview.result.saved.route} />
                    <span>탐지 <span className="mono-fact">{preview.result.saved.detections.length}건</span></span>
                  </div>
                  <div className="dict-preview-summary__row">
                    <strong>편집 중 초안</strong>
                    <GradeBadge grade={preview.result.draft.grade} />
                    <RouteLabel route={preview.result.draft.route} />
                    <span>탐지 <span className="mono-fact">{preview.result.draft.detections.length}건</span></span>
                    {netDetectionDelta !== 0 ? (
                      <strong className="mono-fact">{netDetectionDelta > 0 ? '+' : ''}{netDetectionDelta}</strong>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="dict-preview-summary__row">
                  <strong>검사 결과</strong>
                  <GradeBadge grade={preview.result.saved.grade} />
                  <RouteLabel route={preview.result.saved.route} />
                  <span>탐지 <span className="mono-fact">{preview.result.saved.detections.length}건</span></span>
                </div>
              )}
            </div>

            {canEdit ? (
              <div className="dict-delta">
                {removedDeltas.length > 0 ? (
                  <p className="dict-delta__warning">저장하면 다음 {removedDeltas.length}건을 더 이상 잡지 못한다.</p>
                ) : null}
                <section className="dict-delta__section" aria-labelledby="dict-added-heading">
                  <h3 id="dict-added-heading">이 저장으로 새로 잡는 것</h3>
                  {addedDeltas.length === 0 ? <p className="table-muted">없음</p> : (
                    <ul className="dict-delta__list">
                      {addedDeltas.map((delta) => (
                        <li key={`${delta.kind}-${delta.start}-${delta.end}`}>
                          <span aria-hidden="true">+</span>
                          <strong>{delta.label}</strong>
                          <span>{delta.matched}</span>
                          <code className="dict-delta__offset">{delta.start}:{delta.end}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="dict-delta__section" aria-labelledby="dict-removed-heading">
                  <h3 id="dict-removed-heading">이 저장으로 놓치는 것</h3>
                  {removedDeltas.length === 0 ? <p className="table-muted">없음</p> : (
                    <ul className="dict-delta__list">
                      {removedDeltas.map((delta) => (
                        <li key={`${delta.kind}-${delta.start}-${delta.end}`}>
                          <span aria-hidden="true">−</span>
                          <strong>{delta.label}</strong>
                          <span>{delta.matched}</span>
                          <code className="dict-delta__offset">{delta.start}:{delta.end}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {relabeledDeltas.length > 0 ? (
                  <section className="dict-delta__section" aria-labelledby="dict-relabeled-heading">
                    <h3 id="dict-relabeled-heading">라벨이 바뀌는 것</h3>
                    <ul className="dict-delta__list">
                      {relabeledDeltas.map((delta) => (
                        <li key={`${delta.kind}-${delta.start}-${delta.end}`}>
                          <span aria-hidden="true">→</span>
                          <strong>{delta.previousLabel} → {delta.label}</strong>
                          <span>{delta.matched}</span>
                          <code className="dict-delta__offset">{delta.start}:{delta.end}</code>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}

            <section className="dict-comparison" aria-labelledby="dict-comparison-heading">
              <h3 id="dict-comparison-heading">원문·전송본 대조 {canEdit ? '— 초안 기준' : ''}</h3>
              <InspectionComparison result={preview.result.draft} />
            </section>
          </div>
        ) : null}
      </section>

      <details className="admin-section dict-details" ref={inactiveDetails}>
        <summary className="dict-details__summary">4. 비활성 항목 <span className="mono-fact">{inactiveRows.length}건</span></summary>
        <div className="dict-details__body">
          <DictionaryRows
            canEdit={canEdit}
            falsePositiveHits={falsePositiveHits}
            inactive
            issues={issues}
            rows={inactiveRows}
            savedById={savedById}
            saving={saving}
            onChange={updateRow}
            onDeactivate={(rowId) => updateRow(rowId, { active: false })}
            onGradeTouched={(rowId) => gradeTouchedRows.current.add(rowId)}
            onReactivate={(rowId) => updateRow(rowId, { active: true })}
            onRemove={removeRow}
            registerTermInput={registerTermInput}
          />
        </div>
      </details>

      <details className="admin-section dict-details">
        <summary className="dict-details__summary">5. 등급별 처리</summary>
        <div className="dict-details__body">
          <PolicyTable rows={policyRows} />
          <p className="dict-policy-note">이 매핑은 보안 정책에서 정한다. 이 화면에서는 바꿀 수 없다.</p>
        </div>
      </details>

      {toast ? <div className="admin-toast" role="status">{toast}</div> : null}
    </div>
  )
}
