import { useEffect, useState } from 'react'

export function useMessageJump<T extends { targetId: string }>() {
  const [jump, setJump] = useState<T>()
  useEffect(() => {
    if (!jump) return
    const timer = window.setTimeout(() => setJump(undefined), 1800)
    return () => window.clearTimeout(timer)
  }, [jump])
  return [jump, setJump] as const
}
