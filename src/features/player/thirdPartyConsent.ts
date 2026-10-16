

export const THIRD_PARTY_AGREEMENT_VERSION = '1.0'
export const AGREEMENT_STORAGE_KEY = 'study-with-hoyomix:third-party-agreement:v1'
let refusedInThisPage = false

// No key, account identity or source details are stored in the consent receipt.
export function agreementReceipt(): string | null {
  if (refusedInThisPage) return 'withdrawn'
  try { return localStorage.getItem(AGREEMENT_STORAGE_KEY) } catch { return 'unavailable' }
}
export function hasCurrentAgreement(): boolean {
  return agreementReceipt() === THIRD_PARTY_AGREEMENT_VERSION
}
export function allowsConfiguredSources(): boolean {
  const receipt = agreementReceipt()
  // Existing installations are preserved; every new deliberate activation asks first.
  return receipt === null || receipt === THIRD_PARTY_AGREEMENT_VERSION
}
export function acceptAgreement(): void {
  localStorage.setItem(AGREEMENT_STORAGE_KEY, THIRD_PARTY_AGREEMENT_VERSION)
  refusedInThisPage = false
}
export function withdrawAgreement(): void {
  // Refuse before persistence: a storage failure must not keep custom sources active.
  refusedInThisPage = true
  localStorage.setItem(AGREEMENT_STORAGE_KEY, 'withdrawn')
}
