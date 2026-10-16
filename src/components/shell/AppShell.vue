<script setup lang="ts">
import { onBeforeUnmount, watchEffect } from 'vue'
import { isLocale, translate, type TranslationKey } from '../../i18n'
import LiquidGlassCanvas from '../../features/liquid-glass/LiquidGlassCanvas.vue'
import AccountMenu from '../../features/account/AccountMenu.vue'
import { usePreferences } from '../../stores/preferences'

const props = withDefaults(defineProps<{ legacy?: boolean }>(), { legacy: false })
const { locale, lowPower, setLocale, visualStyle } = usePreferences()

watchEffect(() => {
  document.documentElement.dataset.theme = visualStyle.value
})

onBeforeUnmount(() => {
  delete document.documentElement.dataset.theme
})

function text(key: TranslationKey): string {
  return translate(locale.value, key)
}

function onLocaleChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (isLocale(value)) setLocale(value)
}
</script>

<template>
  <div class="app-shell" :lang="locale">
    <LiquidGlassCanvas v-if="visualStyle !== 'studio'" :low-power="lowPower" />

    <a class="app-shell__skip-link" href="#app-content">{{ text('a11y.skipToContent') }}</a>

    <template v-if="props.legacy">
      <header class="app-shell__bar surface-glass" data-testid="legacy-account-header">
        <h1>{{ text('app.title') }}</h1>

        <nav :aria-label="text('nav.label')">
          <a href="#app-content">{{ text('nav.library') }}</a>
        </nav>

        <div class="app-shell__locale">
          <label for="app-locale">{{ text('preferences.language') }}</label>
          <select id="app-locale" :value="locale" @change="onLocaleChange">
            <option value="zh-Hant">{{ text('locale.zh-Hant') }}</option>
            <option value="zh-Hans">{{ text('locale.zh-Hans') }}</option>
            <option value="en">{{ text('locale.en') }}</option>
          </select>
        </div>

        <AccountMenu />
      </header>

      <main id="app-content" class="app-shell__content" tabindex="-1">
        <slot />
      </main>
    </template>

    <slot v-else />
  </div>
</template>

<style src="../../styles/tokens.css"></style>

<style scoped>
.app-shell {
  position: relative;
  min-height: 100dvh;
  overflow: hidden;
  color: var(--colour-text-primary);
  background: var(--colour-background);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.app-shell::before {
  position: absolute;
  inset: -20% 0 auto 55%;
  z-index: 0;
  width: 12rem;
  aspect-ratio: 1;
  content: "";
  background: radial-gradient(circle, rgb(105 224 207 / 18%), transparent 68%);
  transform: translateY(var(--decorative-displacement));
  transition: transform var(--motion-duration) ease;
}

.app-shell__skip-link {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 1002;
  padding: 0.5rem 0.75rem;
  color: var(--colour-background);
  background: var(--colour-focus);
  border-radius: 0.25rem;
  transform: translateY(-200%);
  transition: transform var(--motion-duration) ease;
}

.app-shell__skip-link:focus {
  transform: translateY(0);
}

.app-shell__bar {
  position: fixed;
  top: 1rem;
  left: 50%;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: stretch;
  padding: 1rem;
  border-radius: var(--radius-surface);
  width: min(calc(100% - 2rem), 72rem);
  transform: translateX(-50%);
}

h1 {
  width: fit-content;
  margin: 0;
  color: var(--colour-text-primary);
  font-size: clamp(1.25rem, 5vw, 1.75rem);
  line-height: 1.2;
  justify-self: start;
}

nav a {
  color: var(--colour-accent-strong);
  font-weight: 650;
  text-underline-offset: 0.25em;
}

.app-shell__locale {
  display: grid;
  gap: 0.375rem;
}

label {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
  font-weight: 650;
}

select {
  min-height: 2.75rem;
  padding: 0.5rem 2rem 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
}

.app-shell__content {
  position: relative;
  width: 100%;
  margin: 0;
}

@media (min-width: 31rem) {
  .app-shell__bar {
    width: min(calc(100% - 10rem), 72rem);
  }
}

@media (min-width: 48rem) {
  .app-shell__bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto auto;
    align-items: center;
    padding: 1rem 1.25rem;
  }

  .app-shell__locale {
    grid-template-columns: auto minmax(10rem, max-content);
    align-items: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-shell::before,
  .app-shell__skip-link {
    transition-duration: 0ms;
  }

  .app-shell::before {
    transform: none;
  }
}
</style>
