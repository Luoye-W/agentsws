import { createRoot } from 'react-dom/client'
import { Options } from '@/ui/options'
import './options.css'

const host = document.getElementById('root')
if (host !== null) createRoot(host).render(<Options />)
