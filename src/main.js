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
