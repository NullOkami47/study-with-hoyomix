<script setup lang="ts">
withDefaults(defineProps<{
  title: string
  message?: string
  icon?: string
}>(), {
  message: '',
  icon: '🔍',
})
</script>

<template>
  <div class="admin-empty-state">
    <div class="admin-empty-state__icon" aria-hidden="true">{{ icon }}</div>
    <h3 class="admin-empty-state__title">{{ title }}</h3>
    <p v-if="message" class="admin-empty-state__message">{{ message }}</p>
    <div v-if="$slots.default" class="admin-empty-state__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.admin-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  margin: 16px 0;
}

.admin-empty-state__icon {
  font-size: 2.5rem;
  margin-bottom: 12px;
  opacity: 0.8;
}

.admin-empty-state__title {
  margin: 0 0 8px;
  font-size: 1.125rem;
  font-weight: 600;
  color: #f1f5f9;
}

.admin-empty-state__message {
  margin: 0 0 16px;
  font-size: 0.875rem;
  color: #94a3b8;
  max-width: 440px;
  line-height: 1.5;
}

.admin-empty-state__actions {
  display: flex;
  gap: 12px;
}
</style>
