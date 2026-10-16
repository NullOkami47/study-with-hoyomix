<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'success' | 'warning' | 'danger' | 'neutral' | 'info'
  size?: 'sm' | 'md'
  pulse?: boolean
  label?: string
}>(), {
  variant: 'neutral',
  size: 'md',
  pulse: false,
  label: '',
})
</script>

<template>
  <span
    class="admin-status-chip"
    :class="[
      `admin-status-chip--${variant}`,
      `admin-status-chip--${size}`,
      { 'admin-status-chip--pulse': pulse },
    ]"
    role="status"
  >
    <span v-if="pulse" class="admin-status-chip__dot" aria-hidden="true" />
    <slot>{{ label }}</slot>
  </span>
</template>

<style scoped>
.admin-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  border-radius: 9999px;
  line-height: 1.2;
  white-space: nowrap;
  font-size: 0.8125rem;
  padding: 3px 10px;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.admin-status-chip--sm {
  font-size: 0.75rem;
  padding: 2px 8px;
}

.admin-status-chip--success {
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
  border-color: rgba(34, 197, 94, 0.28);
}

.admin-status-chip--warning {
  background: rgba(234, 179, 8, 0.12);
  color: #fbbf24;
  border-color: rgba(234, 179, 8, 0.28);
}

.admin-status-chip--danger {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
  border-color: rgba(239, 68, 68, 0.28);
}

.admin-status-chip--info {
  background: rgba(59, 130, 246, 0.12);
  color: #38bdf8;
  border-color: rgba(59, 130, 246, 0.28);
}

.admin-status-chip--neutral {
  background: rgba(100, 116, 139, 0.1);
  color: #94a3b8;
  border-color: rgba(100, 116, 139, 0.2);
}

.admin-status-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: currentColor;
  animation: pulse-ring 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse-ring {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.85);
  }
}
</style>
