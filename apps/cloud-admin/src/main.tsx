import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './index.css'
import { AppProvider } from './lib/app'

const root = document.getElementById('root')
if (root === null) throw new Error('#root 不在——index.html 被改坏了')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename="/admin">
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
)
