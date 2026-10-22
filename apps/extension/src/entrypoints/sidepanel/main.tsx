import { createRoot } from 'react-dom/client'
import { markOs } from '@/ui/mark-os'
import { SidePanel } from '@/ui/side-panel'
import '@/ui/tokens.css'
import './sidepanel.css'

markOs()
const host = document.getElementById('root')
if (host !== null) createRoot(host).render(<SidePanel />)
