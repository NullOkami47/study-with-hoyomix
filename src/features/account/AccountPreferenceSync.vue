<script setup lang="ts">
import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import type { AccountPreferencesRepository, VolumeControls } from './accountPreferences'
import { automaticSyncStatus } from './automaticSync'
defineProps<{ player: VolumeControls; repository?: AccountPreferencesRepository }>()
const preferences = usePreferences()
const text = (key: TranslationKey) => translate(preferences.locale.value, key)
</script>
<template>
  <section class="account-preference-sync" data-account-preference-sync>
    <h4>{{ text('account.preferenceSync.title') }}</h4>
    <p>{{ text('account.preferenceSync.description') }}</p>
    <p v-if="automaticSyncStatus === 'failed'" role="status" aria-live="polite" data-account-preferences-status>{{ text('account.preferenceSync.failed') }}</p>
    <p v-else-if="automaticSyncStatus === 'synced'" role="status" data-account-preferences-status>{{ text('account.preferenceSync.saved') }}</p>
  </section>
</template>
<style scoped>
.account-preference-sync { display: grid; gap: .625rem; padding-block: .5rem; }
.account-preference-sync h4, .account-preference-sync p { margin: 0; }
.account-preference-sync p { color: var(--colour-text-muted); font-size: .875rem; }
</style>
