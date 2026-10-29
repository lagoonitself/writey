import { lazy, Suspense } from 'react'
import { isDesktop } from './lib/native'
import { usePath } from './lib/router'
import { Library } from './notebook/Library'
import { NotebookView } from './notebook/NotebookView'

// The website only shows the download page; Supabase stays out of the desktop app's bundle.
const Site = lazy(() => import('./site/Site').then((m) => ({ default: m.Site })))

export function App() {
  if (!isDesktop()) {
    return (
      <Suspense fallback={null}>
        <Site />
      </Suspense>
    )
  }
  return <Desktop />
}

function Desktop() {
  const path = usePath()
  const notebookId = /^\/n\/([0-9a-f-]{36})$/i.exec(path)?.[1]
  return notebookId ? <NotebookView key={notebookId} id={notebookId} /> : <Library />
}
