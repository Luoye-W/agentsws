import { createRoot } from 'react-dom/client'
import { SidePanel } from '@/ui/side-panel'
import './sidepanel.css'

const host = document.getElementById('root')
if (host !== null) createRoot(host).render(<SidePanel />)
