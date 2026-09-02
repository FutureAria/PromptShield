import type { UserRole } from './types'

export type Capability =
  | 'employee.inspect'          // 직원 화면에서 검사하고 전송한다
  | 'admin.dashboard.view'      // 관리 현황을 본다
  | 'admin.demo.reset'          // 시연용 목 데이터를 씨앗 값으로 되돌린다
  | 'admin.logs.view'           // 감사 로그를 조회한다
  | 'admin.approvals.view'      // 승인 대기 목록을 본다
  | 'admin.approvals.decide'    // 승인·조건부 승인·반려를 처리한다
  | 'admin.dictionary.view'     // 기업 사전을 조회한다
  | 'admin.dictionary.edit'     // 기업 사전을 갱신한다
  | 'admin.users.view'          // 사용자·권한을 조회한다
  | 'admin.users.assign'        // 역할을 배정한다

// ★ 이 표가 유일한 정의다. 라우트 가드, 사이드바, 목 API 권한 검사, 권한 매트릭스 화면이
//   전부 여기서 파생한다. 어느 한 곳에도 역할 리터럴을 다시 쓰지 마라.
//   Record<Capability, Record<UserRole, boolean>> 이므로 능력을 더하면 세 역할 값을 모두
//   적어야 하고, 역할을 더하면 모든 능력이 컴파일 오류로 드러난다.
const CAPABILITY_MATRIX: Record<Capability, Record<UserRole, boolean>> = {
  'employee.inspect':       { employee: true,  approver: true,  auditor: true  },
  'admin.dashboard.view':   { employee: false, approver: true,  auditor: true  },
  'admin.demo.reset':       { employee: false, approver: true,  auditor: false },
  'admin.logs.view':        { employee: false, approver: true,  auditor: true  },
  'admin.approvals.view':   { employee: false, approver: true,  auditor: true  },
  'admin.approvals.decide': { employee: false, approver: true,  auditor: false },
  'admin.dictionary.view':  { employee: false, approver: true,  auditor: true  },
  'admin.dictionary.edit':  { employee: false, approver: true,  auditor: false },
  'admin.users.view':       { employee: false, approver: true,  auditor: true  },
  'admin.users.assign':     { employee: false, approver: true,  auditor: false },
}

export const ROLE_ORDER = ['employee', 'approver', 'auditor'] as const

export const ROLE_LABELS: Record<UserRole, string> = {
  employee: '직원',
  approver: '승인자',
  auditor: '감사자',
}

/** 권한 매트릭스 화면의 행 순서이자, 새 능력에 라벨을 강제하는 표다. */
export const CAPABILITY_ORDER: readonly Capability[] = [
  'employee.inspect',
  'admin.dashboard.view',
  'admin.demo.reset',
  'admin.logs.view',
  'admin.approvals.view',
  'admin.approvals.decide',
  'admin.dictionary.view',
  'admin.dictionary.edit',
  'admin.users.view',
  'admin.users.assign',
]

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'employee.inspect': '직원 화면에서 검사하고 전송한다',
  'admin.dashboard.view': '관리 현황을 본다',
  'admin.demo.reset': '시연용 목 데이터를 초기화한다',
  'admin.logs.view': '감사 로그를 조회한다',
  'admin.approvals.view': '승인 대기 목록을 본다',
  'admin.approvals.decide': '승인·조건부 승인·반려를 처리한다',
  'admin.dictionary.view': '기업 사전을 조회한다',
  'admin.dictionary.edit': '기업 사전을 갱신한다',
  'admin.users.view': '사용자·권한을 조회한다',
  'admin.users.assign': '역할을 배정한다',
}

export function can(role: UserRole, capability: Capability): boolean {
  return CAPABILITY_MATRIX[capability][role]
}

/** 라우트 가드의 allow 배열을 이 표에서 만든다. App.tsx 에 역할 리터럴을 남기지 않는다. */
export function rolesWith(capability: Capability): readonly UserRole[] {
  return ROLE_ORDER.filter((role) => can(role, capability))
}
