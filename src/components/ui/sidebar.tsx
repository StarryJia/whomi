import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

// Adapted from shadcn/ui Sidebar (MIT); see THIRD_PARTY_NOTICES.md.
const STORAGE_KEY = 'whomi:sidebar-open'
const MOBILE_QUERY = '(max-width: 640px)'

function subscribeToViewport(onChange: () => void) {
  const query = window.matchMedia(MOBILE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function readDesktopPreference() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

type SidebarState = {
  open: boolean
  isMobile: boolean
  toggle: () => void
  closeMobile: () => void
}

const SidebarContext = createContext<SidebarState | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [desktopOpen, setDesktopOpen] = useState(readDesktopPreference)
  const [mobileOpen, setMobileOpen] = useState(false)
  const isMobile = useSyncExternalStore(
    subscribeToViewport,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(desktopOpen))
    } catch {
      // 存储受限时仍允许在当前页面使用侧栏。
    }
  }, [desktopOpen])

  useEffect(() => {
    if (!isMobile) setMobileOpen(false)
  }, [isMobile])

  const open = isMobile ? mobileOpen : desktopOpen

  return (
    <SidebarContext.Provider
      value={{
        open,
        isMobile,
        toggle: () => {
          if (isMobile) setMobileOpen((current) => !current)
          else setDesktopOpen((current) => !current)
        },
        closeMobile: () => setMobileOpen(false),
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) throw new Error('Sidebar components require SidebarProvider.')
  return context
}
