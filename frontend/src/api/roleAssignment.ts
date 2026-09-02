import type { UserDirectory, UserRole } from './types'
import { ROLE_LABELS } from './permissions'

export type RoleAssignBlockReason = 'not_permitted' | 'unknown_user' | 'self' | 'last_approver'

export interface RoleAssignBlock { reason: RoleAssignBlockReason; message: string }
export interface RoleAssignmentVerdict {
  blocked: RoleAssignBlock | null
  warning: string | null       // 경고이거나 확정 전 요약 문장이다
}

function blockOf(reason: RoleAssignBlockReason, message: string): RoleAssignmentVerdict {
  return { blocked: { reason, message }, warning: null }
}

function warnOf(message: string): RoleAssignmentVerdict {
  return { blocked: null, warning: message }
}

/**
 * 역할 변경 가능 여부를 판정한다. 화면과 목 API가 같이 쓴다.
 * ★ 순수 함수다. 규칙은 여기에만 둔다. 화면이나 목에 같은 조건을 다시 쓰지 마라.
 */
export function checkRoleAssignment(
  directory: UserDirectory,
  targetUserId: string,
  nextRole: UserRole,
): RoleAssignmentVerdict {
  if (!directory.canAssign) {
    return blockOf('not_permitted', '역할을 배정할 권한이 없다.')
  }

  const target = directory.users.find((user) => user.userId === targetUserId)
  if (!target) {
    return blockOf('unknown_user', '대상 계정을 찾을 수 없다.')
  }
  if (target.isCurrentUser) {
    return blockOf('self', '본인 계정의 역할은 스스로 바꿀 수 없다. 다른 승인자에게 요청한다.')
  }
  if (target.role === nextRole) {
    return { blocked: null, warning: null }   // 변경 없음. 확정 버튼 자체가 나오지 않는다
  }

  if (target.role === 'approver' && directory.roleCounts.approver <= 1) {
    const impact = directory.pendingApprovalCount > 0
      ? `대기 중인 승인 ${directory.pendingApprovalCount}건을 처리할 사람이 없어지고`
      : '새 위험 요청을 처리할 사람이 없어지고'
    return blockOf(
      'last_approver',
      `승인자가 ${target.name} 한 명뿐이다. 지금 강등하면 ${impact}, 역할을 되돌릴 수 있는 사람도 없어진다.`
      + ' 먼저 다른 직원을 승인자로 올린 뒤 다시 시도한다.',
    )
  }

  if (target.role === 'auditor' && directory.roleCounts.auditor <= 1) {
    return warnOf('감사자가 없어진다. 승인 기록을 승인자 본인만 확인하게 된다. 계속하려면 변경을 누른다.')
  }
  if (nextRole === 'approver') {
    return warnOf(
      `승인자가 ${directory.roleCounts.approver + 1}명이 된다.`
      + ' 위험 요청의 원문 전송을 허가할 수 있는 사람이 늘어난다.',
    )
  }

  return warnOf(`${target.name}의 역할을 ${ROLE_LABELS[target.role]}에서 ${ROLE_LABELS[nextRole]}로 바꾼다.`)
}
