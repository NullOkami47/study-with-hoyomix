import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const repositoryRoot = process.cwd()

const runtimeFiles = [
  'src/App.vue',
  'src/main.js',
  'src/style.css',
  'workers/online-counter.js',
]

const legacyFiles = [
  'src/composables/useStudyAuth.js',
  'src/composables/useStudyAuth.spec.ts',
  'src/composables/useStudySync.js',
  'src/composables/useUserProfiles.js',
  'src/components/PomodoroTimer.vue',
  'src/components/PomodoroTimer.spec.ts',
  'src/components/StudyCalendar.vue',
  'src/components/Updates.vue',
  'src/components/ChatPanel.vue',
  'src/components/FloatingChatWindow.vue',
  'src/components/FloatingChatWindow.spec.ts',
  'src/data/localSongs.js',
  'src/data/playlists.js',
  'src/data/quotes.js',
  'src/data/updates.js',
  'src/features/workspace/LegacyWorkspace.vue',
]

const legacyPatterns = [
  /VITE_MIKUMOD_URL/iu,
  /VITE_STUDY_URL/iu,
  /mikumod\.com/iu,
  /Study With Miku/iu,
  /MikuMod/iu,
]

it.each(runtimeFiles)('%s has no inherited product endpoint or branding', (relativePath) => {
  const content = readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
  for (const pattern of legacyPatterns) {
    expect(content).not.toMatch(pattern)
  }
})

it('does not retain legacy product runtime files', () => {
  for (const relativePath of legacyFiles) {
    const fullPath = resolve(repositoryRoot, relativePath)
    let exists = true
    try {
      readFileSync(fullPath)
    } catch {
      exists = false
    }
    expect(exists, `${relativePath} should have been removed`).toBe(false)
  }
})

it('does not import deleted legacy modules from production root source', () => {
  const checkedRoots = ['src/App.vue', 'src/main.js']
  const importPatterns = [
    /LegacyWorkspace/iu,
    /useStudyAuth/iu,
    /useStudySync/iu,
    /useUserProfiles/iu,
    /components\/PomodoroTimer/iu,
    /components\/StudyCalendar/iu,
    /components\/Updates/iu,
    /components\/ChatPanel/iu,
    /components\/FloatingChatWindow/iu,
    /useMusic/iu,
    /useCrossfade/iu,
    /useOnlineCount/iu,
    /useGeoLocation/iu,
    /useCalendar/iu,
    /data\/localSongs/iu,
    /data\/playlists/iu,
    /data\/quotes/iu,
    /data\/updates/iu,
    /utils\/eventBus/iu,
    /utils\/userSettings/iu,
    /utils\/cache/iu,
    /services\/meting/iu,
  ]
  for (const file of checkedRoots) {
    const content = readFileSync(resolve(repositoryRoot, file), 'utf8')
    for (const pattern of importPatterns) {
      expect(content, `${file} must not import deleted legacy module matching ${pattern}`).not.toMatch(pattern)
    }
  }
})
