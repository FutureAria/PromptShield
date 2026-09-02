import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { getStoredSession, login, logout } from '../api'
import type { Session } from '../api/types'

interface SessionContextValue {
  session: Session | null
  signIn: (userId: string) => Promise<Session>
  signOut: () => Promise<void>
  isLoading: boolean
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => getStoredSession())
  const [isLoading, setIsLoading] = useState(false)

  const signIn = useCallback(async (userId: string) => {
    setIsLoading(true)
    try {
      const nextSession = await login(userId)
      setSession(nextSession)
      return nextSession
    } finally {
      setIsLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setIsLoading(true)
    try {
      await logout()
    } finally {
      setSession(null)
      setIsLoading(false)
    }
  }, [])

  const value = useMemo<SessionContextValue>(() => ({
    session,
    signIn,
    signOut,
    isLoading,
  }), [isLoading, session, signIn, signOut])

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) {
    throw new Error('useSession은 SessionProvider 안에서 사용해야 한다.')
  }

  return value
}
