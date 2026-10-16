export const decodeJson = (value: string): Record<string, unknown> => {
  const normalised = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

export const decodeBytes = (value: string): Uint8Array => {
  const normalised = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}
