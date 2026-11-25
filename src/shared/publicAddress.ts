/**
 * IPv4 ranges that are not "somewhere on the public internet": this host, the local network, the
 * carrier-grade NAT range, link-local (which is where cloud metadata services live), documentation
 * and benchmarking ranges, multicast and reserved space.
 */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const ipv4ToInt = (address: string): number | null => {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** Classifies dotted-quad IPv4 only. Other hostnames are screened separately by callers. */
export function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return IPV4_BLOCKED.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base)
    if (baseValue === null) return false
    const size = 2 ** (32 - bits)
    return value >= baseValue && value < baseValue + size
  })
}
