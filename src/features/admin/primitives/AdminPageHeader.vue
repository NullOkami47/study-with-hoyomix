<script setup lang="ts">
import AdminStatusChip from './AdminStatusChip.vue'

withDefaults(defineProps<{
  title: string
  subtitle?: string
  badge?: string
  badgeVariant?: 'success' | 'warning' | 'danger' | 'neutral' | 'info'
}>(), {
  subtitle: '',
  badge: '',
  badgeVariant: 'neutral',
})
</script>

<template>
  <header class="admin-page-header">
    <div class="admin-page-header__content">
      <div class="admin-page-header__title-row">
        <h2 class="admin-page-header__title">{{ title }}</h2>
        <AdminStatusChip v-if="badge" :variant="badgeVariant" size="sm">
          {{ badge }}
        </AdminStatusChip>
      </div>
      <p v-if="subtitle" class="admin-page-header__subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="admin-page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.admin-page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.admin-page-header__content {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.admin-page-header__title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.admin-page-header__title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #f8fafc;
}

.admin-page-header__subtitle {
  margin: 0;
  font-size: 0.875rem;
  color: #94a3b8;
  line-height: 1.4;
}

.admin-page-header__actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
