import * as desktop from './desktop/assets'
import { isDesktop } from './native'
import * as web from './web/assets'

// Imported PDFs and pictures: files on this computer, or R2 on the website.
const impl = isDesktop() ? desktop : web

export const uploadAsset: typeof web.uploadAsset = (...a) => impl.uploadAsset(...a)
export const assetBlob: typeof web.assetBlob = (id) => impl.assetBlob(id)
export const loadImage: typeof web.loadImage = (id) => impl.loadImage(id)
export const primeImage: typeof web.primeImage = (id, img) => impl.primeImage(id, img)
