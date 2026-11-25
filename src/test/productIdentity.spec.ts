import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const englishDescription = 'An unofficial fan project for studying with HOYO-MiX music.'
const traditionalChineseDescription = '一個以 HOYO-MiX 音樂陪伴學習的非官方粉絲專案。'
const simplifiedChineseDescription = '一个以 HOYO-MiX 音乐陪伴学习的非官方粉丝项目。'
const localisedDescription = `${englishDescription} ${traditionalChineseDescription} ${simplifiedChineseDescription}`
const productFiles = [
  'package.json',
  'index.html',
  'public/manifest.json',
  'public/manifest.webmanifest',
  'public/robots.txt',
]

it.each(productFiles)('%s removes inherited product identity', (relativePath) => {
  const content = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
  expect(content).not.toMatch(/mikumod\.com|Study With Miku|StudyWithMiku|初音未來|初音未来|VOCALOID|SHSHOUSE/iu)
})

it('publishes the three-language description and local icon contract', () => {
  const index = readFileSync(resolve(repositoryRoot, 'index.html'), 'utf8')
  const packageMetadata = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'))
  const manifests = ['public/manifest.json', 'public/manifest.webmanifest'].map((relativePath) => (
    JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), 'utf8'))
  ))

  expect(packageMetadata).toMatchObject({
    name: 'study-with-hoyomix',
    description: localisedDescription,
  })
  expect(index).toContain('<html lang="zh-Hant">')
  expect(index).toContain('<title>Study with HOYO-MiX</title>')
  expect(index).toContain(`content="${localisedDescription}"`)
  expect(index).toContain(`<p lang="en-GB">${englishDescription}</p>`)
  expect(index).toContain(`<p lang="zh-Hant">${traditionalChineseDescription}</p>`)
  expect(index).toContain(`<p lang="zh-Hans">${simplifiedChineseDescription}</p>`)
  expect(index).not.toMatch(/<link\s+rel="(?:canonical|alternate)"/iu)

  for (const manifest of manifests) {
    expect(manifest).toMatchObject({
      name: 'Study with HOYO-MiX',
      description: localisedDescription,
      lang: 'zh-Hant',
    })
    expect(manifest.icons.map(({ src }: { src: string }) => src)).toEqual([
      '/pwa-icon-192.png',
      '/pwa-icon-512.png',
      '/pwa-icon-192.png',
      '/pwa-icon-512.png',
    ])
  }
})

it('keeps robots limited to its index policy', () => {
  const robots = readFileSync(resolve(repositoryRoot, 'public/robots.txt'), 'utf8').replace(/\r\n/g, '\n')
  expect(robots).toBe('User-agent: *\nAllow: /\n')
})

it('does not publish a sitemap before a real production origin is configured', () => {
  expect(existsSync(resolve(repositoryRoot, 'public/sitemap.xml'))).toBe(false)
})
