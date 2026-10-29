import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { getDesktopClient } from './data/desktop-client'

const client = window.whomi ? getDesktopClient() : undefined
createRoot(document.getElementById('root')!).render(<StrictMode><App client={client} importApi={client} /></StrictMode>)
