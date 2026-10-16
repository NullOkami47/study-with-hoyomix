<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import AppShell from './components/shell/AppShell.vue'
import StudyWorkspace from './features/workspace/StudyWorkspace.vue'
import AdminShell from './features/admin/AdminShell.vue'

const isAdmin = ref(window.location.pathname.startsWith('/admin'))

const onPopState = () => {
  isAdmin.value = window.location.pathname.startsWith('/admin')
}

onMounted(() => window.addEventListener('popstate', onPopState))
onBeforeUnmount(() => window.removeEventListener('popstate', onPopState))
</script>

<template>
  <AdminShell v-if="isAdmin" />
  <AppShell v-else>
    <StudyWorkspace />
  </AppShell>
</template>
