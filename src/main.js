// Debug log capture (task 41.8). Imported first so it is installed before the app's modules
// evaluate: errors, console output and failed API calls from startup are in the exported log
// even if the player never renders.
import './features/player/debugLogStartup'
import { createApp } from 'vue'
import App from './App.vue'
import { registerPwa } from './pwa/register'
import './style.css'

const metaCommit = document.querySelector('meta[name="build-commit"]')?.getAttribute('content')
const metaTime = document.querySelector('meta[name="build-time"]')?.getAttribute('content')
const metaEnv = document.querySelector('meta[name="build-env"]')?.getAttribute('content') || 'unknown'
if (metaCommit) {
  window.__BUILD_INFO__ = { commit: metaCommit, buildTime: metaTime, environment: metaEnv }
}

createApp(App).mount('#app')
registerPwa()
