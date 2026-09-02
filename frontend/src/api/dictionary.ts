import type {
  DictionaryDraftEntry,
  DictionaryEntry,
  DictionaryEntryType,
  DictionaryGrade,
  DictionaryIssue,
  DetectionType,
  FalsePositiveHit,
} from './types'

export const DICTIONARY_ACTIVE_LIMIT = 300
export const DICTIONARY_PASTE_ROW_LIMIT = 200
export const DICTIONARY_PRIORITY = 3

export interface DictionaryStoreState {
  revision: number
  updatedAt: string
  entries: DictionaryEntry[]
  sequence: number
}

export interface DictionaryPreset {
  typeLabel: string          // 표의 유형 select 에 보이는 한글
  detectionType: DetectionType
  label: string              // 탐지 항목 라벨. 감사 집계의 축이다
  tokenLabel: string         // 전송본 토큰 예: [거래처1]
  defaultGrade: DictionaryGrade
  confidence: number
}

// ★ 프리셋은 코드 고정이다. 사용자가 편집하지 않는다.
//   label 은 감사 로그·대시보드의 집계 키이므로 자유 입력으로 열면 집계 축이 무한히 늘어난다.
export const dictionaryPresets: Readonly<Record<DictionaryEntryType, DictionaryPreset>> = {
  partner:          { typeLabel: '거래처',   detectionType: 'partner', label: '거래처',    tokenLabel: '거래처', defaultGrade: 'confidential', confidence: 0.96 },
  product_code:     { typeLabel: '제품코드', detectionType: 'partner', label: '제품코드',  tokenLabel: '제품',   defaultGrade: 'confidential', confidence: 0.96 },
  price_expression: { typeLabel: '단가표현', detectionType: 'price',   label: '단가',      tokenLabel: '단가',   defaultGrade: 'confidential', confidence: 0.95 },
  other:            { typeLabel: '기타',     detectionType: 'partner', label: '사내 용어', tokenLabel: '용어',   defaultGrade: 'caution',      confidence: 0.96 },
}

const SEED_UPDATED_AT = '2026-08-25T02:00:00.000Z'

// ★ 씨앗은 이관 전 findCandidates 의 거래처 리터럴과 문자 그대로 같아야 한다.
//   term/label/tokenLabel/confidence/severity/priority 중 하나라도 바뀌면 시연 G-03과
//   감사 로그의 '거래처' 라벨 집계가 어긋난다.
const seedEntries: readonly DictionaryEntry[] = ['ABC상사', '대한물산', '한빛테크'].map((term, index) => ({
  id: `dict-seed-${index + 1}`,
  term,
  entryType: 'partner',
  grade: 'confidential',
  active: true,
  note: '',
  updatedAt: SEED_UPDATED_AT,
  updatedBy: '초기 설정',
}))

let entries: DictionaryEntry[] = seedEntries.map((entry) => ({ ...entry }))
let revision = 1
let updatedAt = SEED_UPDATED_AT
let dictSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDictionaryEntry(value: unknown): value is DictionaryEntry {
  if (!isRecord(value)) return false

  return typeof value.id === 'string'
    && typeof value.term === 'string'
    && (value.entryType === 'partner'
      || value.entryType === 'product_code'
      || value.entryType === 'price_expression'
      || value.entryType === 'other')
    && (value.grade === 'caution' || value.grade === 'confidential')
    && typeof value.active === 'boolean'
    && typeof value.note === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.updatedBy === 'string'
}

/** 단일 목 상태 스냅숏에 넣을 사전 내부 상태를 복제한다. */
export function readDictionaryStoreState(): DictionaryStoreState {
  return {
    revision,
    updatedAt,
    entries: entries.map((entry) => ({ ...entry })),
    sequence: dictSequence,
  }
}

/** sessionStorage에서 읽은 값을 검증한 뒤에만 사전 상태 전체를 교체한다. */
export function restoreDictionaryStoreState(value: unknown): boolean {
  if (!isRecord(value)
    || !Number.isInteger(value.revision) || (value.revision as number) < 1
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.entries) || !value.entries.every(isDictionaryEntry)
    || !Number.isInteger(value.sequence) || (value.sequence as number) < 0) {
    return false
  }

  revision = value.revision as number
  updatedAt = value.updatedAt
  entries = value.entries.map((entry) => ({ ...entry }))
  dictSequence = value.sequence as number
  return true
}

export function readDictionary(): { revision: number; updatedAt: string; entries: DictionaryEntry[] } {
  return { revision, updatedAt, entries: entries.map((entry) => ({ ...entry })) }
}

export function getActiveDictionaryEntries(): readonly DictionaryEntry[] {
  return entries.filter((entry) => entry.active)
}

/** 초안 전체를 저장소에 반영한다. 검증은 호출부(mock.ts)가 이미 끝냈다고 본다. */
export function commitDictionary(draft: readonly DictionaryDraftEntry[], actorName: string): void {
  const now = new Date().toISOString()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  entries = draft.map((row) => {
    const term = row.term.trim()
    const note = row.note.trim()
    const previous = row.id ? byId.get(row.id) : undefined
    const unchanged = previous
      && previous.term === term && previous.entryType === row.entryType
      && previous.grade === row.grade && previous.active === row.active && previous.note === note

    if (previous && unchanged) return { ...previous }

    dictSequence += 1
    return {
      id: previous?.id ?? `dict-${Date.now().toString(36)}-${dictSequence.toString(36).padStart(3, '0')}`,
      term,
      entryType: row.entryType,
      grade: row.grade,
      active: row.active,
      note,
      updatedAt: now,
      updatedBy: actorName,
    }
  })

  revision += 1
  updatedAt = now
}

/** 테스트에서 사전을 초기 상태로 되돌린다. 새 테스트의 afterEach 에서 반드시 부른다. */
export function resetDictionaryStore(): void {
  entries = seedEntries.map((entry) => ({ ...entry }))
  revision = 1
  updatedAt = SEED_UPDATED_AT
  dictSequence = 0
}

export function validateDraft(
  draft: readonly DictionaryDraftEntry[],
  saved: readonly DictionaryEntry[],
): DictionaryIssue[] {
  const issues: DictionaryIssue[] = []
  const activeTerms = new Set<string>()

  for (const row of draft) {
    const term = row.term.trim()
    const note = row.note.trim()

    if (term.length === 0) {
      issues.push({
        rowId: row.rowId,
        field: 'term',
        level: 'error',
        code: 'term_empty',
        message: '용어를 입력한다.',
      })
    } else if (term.length === 1) {
      issues.push({
        rowId: row.rowId,
        field: 'term',
        level: 'error',
        code: 'term_too_short',
        message: '한 글자 용어는 문장 곳곳에 걸려 오탐을 만든다. 두 글자 이상으로 적는다.',
      })
    } else if (term.length === 2) {
      issues.push({
        rowId: row.rowId,
        field: 'term',
        level: 'warning',
        code: 'term_short_warning',
        message: '두 글자 용어는 무관한 문장에도 걸릴 수 있다. 아래 시험 검사로 확인한다.',
      })
    } else if (term.length > 40) {
      issues.push({
        rowId: row.rowId,
        field: 'term',
        level: 'error',
        code: 'term_too_long',
        message: '40자를 넘는 용어는 완전 일치하는 일이 거의 없다. 짧은 핵심어로 나눈다.',
      })
    }

    if (term.length > 0 && /^[\d,.-]+$/.test(term)) {
      issues.push({
        rowId: row.rowId,
        field: 'term',
        level: 'warning',
        code: 'term_numeric_only',
        message: '숫자만으로 된 용어는 무관한 수치에도 걸린다.',
      })
    }

    if (row.active && term.length > 0) {
      if (activeTerms.has(term)) {
        issues.push({
          rowId: row.rowId,
          field: 'term',
          level: 'error',
          code: 'term_duplicate',
          message: '이미 등록된 용어다.',
        })
      } else {
        activeTerms.add(term)
      }

      if (saved.some((entry) => (
        !entry.active && entry.term === term && entry.id !== row.id
      ))) {
        issues.push({
          rowId: row.rowId,
          field: 'term',
          level: 'warning',
          code: 'term_inactive_exists',
          message: '같은 용어가 비활성 상태로 있다. 새로 추가하는 대신 다시 활성화할 수 있다.',
        })
      }
    }

    if (note.length > 100) {
      issues.push({
        rowId: row.rowId,
        field: 'note',
        level: 'error',
        code: 'note_too_long',
        message: '메모는 100자까지 적는다.',
      })
    }
  }

  if (draft.filter((row) => row.active).length > DICTIONARY_ACTIVE_LIMIT) {
    issues.push({
      rowId: 'total',
      field: 'total',
      level: 'error',
      code: 'active_limit',
      message: '활성 항목이 상한 300건을 넘었다. 쓰지 않는 항목을 비활성화한다.',
    })
  }

  return issues
}

// 문서의 경계·예외 절이 정한 '낱말만 겹치는 정상 업무 문장' 세트다.
// 첫 문장은 시연 G-01의 입력과 같다.
export const FALSE_POSITIVE_PROBE: readonly string[] = [
  '회의록 요약 양식을 알려줘',
  '주민등록등본 발급 절차를 정리해줘',
  '이번 분기 매출 보고서 목차를 잡아줘',
  '신규 입사자 온보딩 안내문 초안을 써줘',
]

export function probeFalsePositives(draft: readonly DictionaryDraftEntry[]): FalsePositiveHit[] {
  const hits: FalsePositiveHit[] = []
  for (const sentence of FALSE_POSITIVE_PROBE) {
    for (const row of draft) {
      const term = row.term.trim()
      if (!row.active || term.length === 0) continue
      if (sentence.includes(term)) {
        hits.push({
          sentence,
          rowId: row.rowId,
          label: dictionaryPresets[row.entryType].label,
          matched: term,
        })
      }
    }
  }
  return hits
}

export type PasteVerdict = 'new' | 'same' | 'changed' | 'error'

export interface ParsedPasteRow {
  lineNumber: number           // 붙여넣은 텍스트에서의 줄 번호(헤더 포함)
  term: string
  entryType: DictionaryEntryType
  grade: DictionaryGrade
  note: string
  verdict: PasteVerdict
  errorMessage?: string        // verdict === 'error' 일 때만
}

export interface ParsedPaste {
  rows: ParsedPasteRow[]
  truncated: boolean           // 200행 초과로 잘랐다
  extraColumns: boolean        // 5열 이상이라 앞 4열만 읽었다
  summary: { added: number; changed: number; same: number; error: number }
}

const typeByLabel: Readonly<Record<string, DictionaryEntryType>> = Object.fromEntries(
  Object.entries(dictionaryPresets).map(([entryType, preset]) => [preset.typeLabel, entryType]),
) as Record<string, DictionaryEntryType>

const gradeByLabel: Readonly<Record<string, DictionaryGrade>> = {
  '주의': 'caution',
  '기밀': 'confidential',
}

function parseCommaSeparatedLine(line: string): string[] {
  const columns: string[] = []
  let column = ''
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        column += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      columns.push(column)
      column = ''
    } else {
      column += character
    }
  }

  columns.push(column)
  return columns
}

function pasteRowError(term: string, note: string): string | undefined {
  if (term.length === 0) return '용어를 입력한다.'
  if (term.length === 1) {
    return '한 글자 용어는 문장 곳곳에 걸려 오탐을 만든다. 두 글자 이상으로 적는다.'
  }
  if (term.length > 40) {
    return '40자를 넘는 용어는 완전 일치하는 일이 거의 없다. 짧은 핵심어로 나눈다.'
  }
  if (note.length > 100) return '메모는 100자까지 적는다.'
  return undefined
}

export function parseDictionaryPaste(
  text: string,
  draft: readonly DictionaryDraftEntry[],
  defaultType: DictionaryEntryType,
): ParsedPaste {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const tabSeparated = firstLine.includes('\t')
  const lines = text.split(/\r?\n/)
  const sourceRows: { lineNumber: number; columns: string[] }[] = []
  let extraColumns = false
  let firstContentLine = true

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim().length === 0) continue

    const columns = tabSeparated ? line.split('\t') : parseCommaSeparatedLine(line)
    if (columns.length > 4) extraColumns = true
    if (firstContentLine) {
      firstContentLine = false
      if ((columns[0] ?? '').trim() === '용어') continue
    }
    sourceRows.push({ lineNumber: index + 1, columns: columns.slice(0, 4) })
  }

  const truncated = sourceRows.length > DICTIONARY_PASTE_ROW_LIMIT
  const rows = sourceRows.slice(0, DICTIONARY_PASTE_ROW_LIMIT).map(({ lineNumber, columns }): ParsedPasteRow => {
    const term = (columns[0] ?? '').trim()
    const typeLabel = columns.length >= 2 ? (columns[1] ?? '').trim() : undefined
    const parsedType = typeLabel === undefined ? defaultType : typeByLabel[typeLabel]
    const entryType = parsedType ?? defaultType
    const gradeLabel = columns.length >= 3 ? (columns[2] ?? '').trim() : undefined
    const parsedGrade = gradeLabel === undefined
      ? dictionaryPresets[entryType].defaultGrade
      : gradeByLabel[gradeLabel]
    const grade = parsedGrade ?? dictionaryPresets[entryType].defaultGrade
    const note = (columns[3] ?? '').trim()

    let errorMessage: string | undefined
    if (!parsedType) {
      errorMessage = '알 수 없는 유형이다. 거래처·제품코드·단가표현·기타 중에서 적는다.'
    } else if (!parsedGrade) {
      errorMessage = '등급은 주의 또는 기밀로 적는다.'
    } else {
      errorMessage = pasteRowError(term, note)
    }

    if (errorMessage) {
      return { lineNumber, term, entryType, grade, note, verdict: 'error', errorMessage }
    }

    const current = draft.find((row) => row.term.trim() === term)
    if (!current) {
      return { lineNumber, term, entryType, grade, note, verdict: 'new' }
    }

    const verdict: PasteVerdict = current.entryType === entryType
      && current.grade === grade
      && current.note.trim() === note
      ? 'same'
      : 'changed'
    return { lineNumber, term, entryType, grade, note, verdict }
  })

  const summary = rows.reduce<ParsedPaste['summary']>((counts, row) => {
    if (row.verdict === 'new') counts.added += 1
    else counts[row.verdict] += 1
    return counts
  }, { added: 0, changed: 0, same: 0, error: 0 })

  return { rows, truncated, extraColumns, summary }
}
