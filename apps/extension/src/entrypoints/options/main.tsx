import { createRoot } from 'react-dom/client'
import { markOs } from '@/ui/mark-os'
import { Options } from '@/ui/options'
import '@/ui/tokens.css'
import './options.css'

markOs()
const host = document.getElementById('root')
if (host !== null) createRoot(host).render(<Options />)
