import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const icons = [
  {
    source: 'scripts/pwa-icons/pwa-icon-192.png.base64.txt',
    output: 'public/pwa-icon-192.png',
    size: 192,
    sha256: 'ba8358c4c8de8ba7413cbe10b5b874fbb89f01727c174c18a563a16425713dc5',
  },
  {
    source: 'scripts/pwa-icons/pwa-icon-512.png.base64.txt',
    output: 'public/pwa-icon-512.png',
    size: 512,
    sha256: 'a3ff57ca3dd767afb215cbd275854918e4ad9b5534b98f765684b7719a0f25cf',
  },
]

function decodeIcon(encoded, icon) {
  const compact = encoded.replace(/\s/g, '')
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(`${icon.source} is not valid Base64 text`)
  }

  const png = Buffer.from(compact, 'base64')
  if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error(`${icon.source} does not decode to a PNG`)
  }
  if (png.readUInt32BE(16) !== icon.size || png.readUInt32BE(20) !== icon.size) {
    throw new Error(`${icon.source} does not decode to a ${icon.size}x${icon.size} icon`)
  }

  const digest = createHash('sha256').update(png).digest('hex')
  if (digest !== icon.sha256) {
    throw new Error(`${icon.source} failed its SHA-256 integrity check`)
  }
  return png
}

for (const icon of icons) {
  const encoded = await readFile(resolve(root, icon.source), 'utf8')
  const png = decodeIcon(encoded, icon)
  const output = resolve(root, icon.output)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, png)
  console.log(`Generated ${icon.output} (${icon.size}x${icon.size})`)
}
