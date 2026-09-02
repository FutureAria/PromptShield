import { useEffect, useState } from 'react'
import {
  assignRole,
  can,
  CAPABILITY_LABELS,
  CAPABILITY_ORDER,
  checkRoleAssignment,
  listRoleChanges,
  listUsers,
  ROLE_LABELS,
  ROLE_ORDER,
} from '../api'
import type { ManagedUser, RoleChangeEntry, UserDirectory, UserRole } from '../api'
import { useSession } from '../auth/SessionContext'

const employeeRole = ROLE_ORDER[0]
const approverRole = ROLE_ORDER[1]
const auditorRole = ROLE_ORDER[2]
const summaryRoleOrder = [approverRole, auditorRole, employeeRole] as const

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function userStatus(user: ManagedUser, directory: UserDirectory): string {
  const status: string[] = []
  if (user.isCurrentUser) status.push('본인')
  if (user.role === approverRole && directory.roleCounts[approverRole] <= 1) {
    status.push('마지막 승인자')
  }
  if (user.role === auditorRole && directory.roleCounts[auditorRole] <= 1) {
    status.push('유일한 감사자')
  }
  return status.length > 0 ? status.join(' · ') : '—'
}

function removePendingRole(
  pendingRoles: Partial<Record<string, UserRole>>,
  userId: string,
): Partial<Record<string, UserRole>> {
  const next = { ...pendingRoles }
  delete next[userId]
  return next
}

// 한국어 조사는 앞말 받침에 따라 달라진다. 이름과 역할 이름이 모두 들어오므로
// 고정 조사를 쓰면 "김철수이", "직원로" 같은 문장이 나온다.
function hasFinalConsonant(word: string): boolean {
  const last = word.trim().slice(-1)
  const code = last.charCodeAt(0)
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return false
  return (code - 0xac00) % 28 !== 0
}

/** 받침이 ㄹ 이면 '로', 그 밖의 받침이면 '으로'. */
function hasRieulFinal(word: string): boolean {
  const last = word.trim().slice(-1)
  const code = last.charCodeAt(0)
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return false
  return (code - 0xac00) % 28 === 8
}

const subject = (word: string) => `${word}${hasFinalConsonant(word) ? '이' : '가'}`
const object = (word: string) => `${word}${hasFinalConsonant(word) ? '을' : '를'}`
const direction = (word: string) => (
  `${word}${!hasFinalConsonant(word) || hasRieulFinal(word) ? '로' : '으로'}`
)

export default function UsersPage() {
  const { session } = useSession()
  const [directory, setDirectory] = useState<UserDirectory | null>(null)
  const [roleChanges, setRoleChanges] = useState<RoleChangeEntry[]>([])
  const [pendingRoles, setPendingRoles] = useState<Partial<Record<string, UserRole>>>({})
  const [assigningUserId, setAssigningUserId] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true

    async function load() {
      setLoading(true)
      setError('')
      try {
        const [nextDirectory, nextRoleChanges] = await Promise.all([
          listUsers(),
          listRoleChanges(5),
        ])
        if (!active) return
        setDirectory(nextDirectory)
        setRoleChanges(nextRoleChanges)
        setPendingRoles({})
        setRowErrors({})
      } catch {
        if (active) {
          setError('사용자와 권한 정보를 불러오지 못했다. 잠시 후 다시 시도해 주세요.')
        }
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
    if (!toast) return undefined
    const timeoutId = window.setTimeout(() => setToast(''), 4000)
    return () => window.clearTimeout(timeoutId)
  }, [toast])

  function chooseRole(user: ManagedUser, nextRole: UserRole) {
    setRowErrors((current) => {
      const next = { ...current }
      delete next[user.userId]
      return next
    })
    setPendingRoles((current) => (
      nextRole === user.role
        ? removePendingRole(current, user.userId)
        : { ...current, [user.userId]: nextRole }
    ))
  }

  function cancelRoleChange(userId: string) {
    setPendingRoles((current) => removePendingRole(current, userId))
    setRowErrors((current) => {
      const next = { ...current }
      delete next[userId]
      return next
    })
  }

  async function confirmRoleChange(user: ManagedUser, nextRole: UserRole) {
    if (!directory) return

    const verdict = checkRoleAssignment(directory, user.userId, nextRole)
    if (verdict.blocked) return

    setAssigningUserId(user.userId)
    setRowErrors((current) => {
      const next = { ...current }
      delete next[user.userId]
      return next
    })

    try {
      await assignRole(user.userId, nextRole)
      const [nextDirectory, nextRoleChanges] = await Promise.all([
        listUsers(),
        listRoleChanges(5),
      ])
      setDirectory(nextDirectory)
      setRoleChanges(nextRoleChanges)
      setPendingRoles((current) => removePendingRole(current, user.userId))
      setToast(
        `${subject(session?.name ?? '보안 관리자')} ${object(user.name)} ${direction(ROLE_LABELS[nextRole])} 바꿨다.`,
      )
    } catch (reason) {
      const message = reason instanceof Error
        ? reason.message
        : '역할을 바꾸지 못했다. 잠시 후 다시 시도해 주세요.'
      setRowErrors((current) => ({ ...current, [user.userId]: message }))
    } finally {
      setAssigningUserId(null)
    }
  }

  if (loading) {
    return (
      <section className="admin-status" aria-live="polite">
        <span className="admin-spinner" aria-hidden="true" />
        <h1>사용자와 권한을 불러오는 중이다</h1>
        <p>계정 역할과 최근 변경 기록을 확인하고 있다.</p>
      </section>
    )
  }

  if (error || !directory) {
    return (
      <section className="admin-status" role="alert">
        <h1>사용자와 권한을 표시하지 못했다</h1>
        <p>{error || '알 수 없는 오류가 발생했다.'}</p>
        <button
          className="admin-button"
          type="button"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          다시 불러오기
        </button>
      </section>
    )
  }

  return (
    <div className="admin-page users-page">
      <header className="admin-page__header">
        <div>
          <p className="admin-page__eyebrow">역할 배정</p>
          <h1>사용자·권한</h1>
          <p>누가 무엇을 할 수 있는지 확인하고 역할을 바꾼다.</p>
        </div>
        <span className="admin-result-count users-summary" aria-live="polite">
          {summaryRoleOrder.map((role, index) => (
            <span key={role}>
              {index > 0 ? ' · ' : ''}{ROLE_LABELS[role]} <strong>{directory.roleCounts[role]}</strong>
            </span>
          ))}
          <span> · 승인 대기 <strong>{directory.pendingApprovalCount}</strong>건</span>
        </span>
      </header>

      {!directory.canAssign && (
        <div className="privacy-notice" role="note">
          <span aria-hidden="true">—</span>
          <p><strong>조회 전용이다.</strong> 역할 변경은 승인자만 할 수 있다.</p>
        </div>
      )}

      {directory.roleCounts[auditorRole] === 0 && (
        <div className="privacy-notice" role="note">
          <span aria-hidden="true">—</span>
          <p><strong>감사자가 0명이다.</strong> 승인 처리와 기록 확인을 같은 사람이 하고 있다.</p>
        </div>
      )}

      <section className="admin-section users-section" aria-labelledby="users-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">계정별 역할</p>
            <h2 id="users-heading">사용자</h2>
          </div>
        </div>

        {directory.users.length === 0 ? (
          <p className="admin-empty">표시할 계정이 없다.</p>
        ) : (
          <div className="audit-table-wrap">
            <table className="audit-table users-table">
              <caption className="visually-hidden">사용자별 부서, 역할, 마지막 활동과 역할 변경 상태</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">부서</th>
                  <th scope="col">역할</th>
                  <th scope="col">마지막 활동</th>
                  <th scope="col">상태</th>
                  {directory.canAssign && <th scope="col">역할 변경 *</th>}
                </tr>
              </thead>
              <tbody>
                {directory.users.map((user) => {
                  const nextRole = pendingRoles[user.userId] ?? user.role
                  const hasPendingChange = nextRole !== user.role
                  const verdict = hasPendingChange
                    ? checkRoleAssignment(directory, user.userId, nextRole)
                    : null
                  const changeMessage = verdict?.blocked?.message ?? verdict?.warning
                  const noteId = `users-change-note-${user.userId}`
                  const isAssigning = assigningUserId === user.userId
                  const status = userStatus(user, directory)

                  return (
                    <tr key={user.userId}>
                      <th scope="row">{user.name}</th>
                      <td>{user.department}</td>
                      <td><span className="role-badge">{ROLE_LABELS[user.role]}</span></td>
                      <td>
                        {user.lastActiveAt ? (
                          <time className="audit-time" dateTime={user.lastActiveAt}>
                            {formatDateTime(user.lastActiveAt)}
                          </time>
                        ) : (
                          <span className="table-muted">기록 없음</span>
                        )}
                      </td>
                      <td>
                        <span className={status === '—' ? 'table-muted' : undefined}>{status}</span>
                      </td>
                      {directory.canAssign && (
                        <td>
                          {user.isCurrentUser ? (
                            <span className="table-muted">본인</span>
                          ) : (
                            <div className="users-role-cell">
                              <label>
                                <span className="visually-hidden">{user.name} 역할</span>
                                <select
                                  aria-label={`${user.name} 역할`}
                                  disabled={assigningUserId !== null}
                                  value={nextRole}
                                  onChange={(event) => chooseRole(user, event.target.value as UserRole)}
                                >
                                  {ROLE_ORDER.map((role) => (
                                    <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                                  ))}
                                </select>
                              </label>

                              {hasPendingChange && (
                                <div className="users-change-confirmation">
                                  {changeMessage && (
                                    <p className="users-change-note" id={noteId} role="note">
                                      {changeMessage}
                                    </p>
                                  )}
                                  <div className="users-change-actions">
                                    <button
                                      aria-describedby={changeMessage ? noteId : undefined}
                                      className="admin-button"
                                      disabled={isAssigning || Boolean(verdict?.blocked)}
                                      type="button"
                                      onClick={() => void confirmRoleChange(user, nextRole)}
                                    >
                                      {isAssigning ? '변경 중' : '변경'}
                                    </button>
                                    <button
                                      className="admin-button admin-button--quiet"
                                      disabled={isAssigning}
                                      type="button"
                                      onClick={() => cancelRoleChange(user.userId)}
                                    >
                                      취소
                                    </button>
                                  </div>
                                </div>
                              )}

                              {rowErrors[user.userId] && (
                                <p className="action-error" role="alert">{rowErrors[user.userId]}</p>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {directory.canAssign && (
          <p className="users-footnote">
            * 본인 계정의 역할은 스스로 바꿀 수 없다. 다른 승인자에게 요청한다.
          </p>
        )}
      </section>

      <section className="admin-section users-section" aria-labelledby="permissions-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">역할별 허용 범위</p>
            <h2 id="permissions-heading">권한 매트릭스</h2>
          </div>
        </div>

        <div className="audit-table-wrap">
          <table className="audit-table users-matrix">
            <caption className="visually-hidden">역할별 기능 허용 여부</caption>
            <thead>
              <tr>
                <th scope="col">조작</th>
                {ROLE_ORDER.map((role) => <th key={role} scope="col">{ROLE_LABELS[role]}</th>)}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_ORDER.map((capability) => (
                <tr key={capability}>
                  <th scope="row">{CAPABILITY_LABELS[capability]}</th>
                  {ROLE_ORDER.map((role) => {
                    const allowed = can(role, capability)
                    return (
                      <td aria-label={`${ROLE_LABELS[role]} · ${allowed ? '허용' : '불가'}`} key={role}>
                        <span aria-hidden="true">{allowed ? '●' : '—'}</span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="users-matrix-note">
          감사자 열은 승인자 열의 부분집합이다. 승인자가 한 명이라도 남으면 모든 조작을 할 사람이 있다.
        </p>
      </section>

      <section className="admin-section users-section" aria-labelledby="role-history-heading">
        <div className="admin-section__heading">
          <div>
            <p className="admin-section__label">최근 5건</p>
            <h2 id="role-history-heading">최근 역할 변경</h2>
          </div>
        </div>

        {roleChanges.length === 0 ? (
          <p className="admin-empty">아직 역할을 바꾼 기록이 없다.</p>
        ) : (
          <ol className="users-history">
            {roleChanges.map((entry) => (
              <li key={entry.id}>
                <time className="audit-time" dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                <span>
                  {subject(entry.actorName)} {object(entry.targetName)} {ROLE_LABELS[entry.from]}에서 {direction(ROLE_LABELS[entry.to])} 바꿨다.
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {toast && <div className="admin-toast" role="status">{toast}</div>}
    </div>
  )
}
