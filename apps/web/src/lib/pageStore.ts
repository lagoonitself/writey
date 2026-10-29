import * as desktop from './desktop/pageStore'
import { isDesktop } from './native'
import * as web from './web/pageStore'

// Page ink: gzipped in the desktop app's database, or in R2 through the Worker on the website.
const impl = isDesktop() ? desktop : web

export type { LoadedPage, SaveResult } from './web/pageStore'
export const loadPage: typeof web.loadPage = (id) => impl.loadPage(id)
export const savePage: typeof web.savePage = (...a) => impl.savePage(...a)
export const backupPage: typeof web.backupPage = (...a) => impl.backupPage(...a)
export const clearBackup: typeof web.clearBackup = (id) => impl.clearBackup(id)
