import type { MechbayBridge } from '../shared/bridge'

declare global {
  interface Window {
    mechbay: MechbayBridge
  }
}
