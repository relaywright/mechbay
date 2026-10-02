import type { MechBayApi } from './index'

declare global {
  interface Window {
    mechbay: MechBayApi
  }
}
