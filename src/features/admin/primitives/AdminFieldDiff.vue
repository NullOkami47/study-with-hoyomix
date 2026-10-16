<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{
  before?: Record<string, any> | null
  after?: Record<string, any> | null
  labels?: Record<string, string>
  exclude?: string[]
}>(), {
  before: () => ({}),
  after: () => ({}),
  labels: () => ({}),
  exclude: () => [],
})

const showUnchanged = ref(false)

function stringifyValue(val: any): string {
  if (val === null || val === undefined) return '\u2014'
  if (typeof val === 'boolean') return val ? 'True' : 'False'
  if (Array.isArray(val)) {
    if (val.length === 0) return '[]'
    return val.join(', ')
  }
  if (typeof val === 'object') {
    return JSON.stringify(val)
  }
  return String(val)
}

function areEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

interface DiffRow {
  key: string
  label: string
  status: 'added' | 'removed' | 'changed' | 'unchanged'
  beforeFormatted: string
  afterFormatted: string
}

const diffRows = computed<DiffRow[]>(() => {
  const b = props.before ?? {}
  const a = props.after ?? {}
  const excludedSet = new Set(props.exclude)

  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => !excludedSet.has(k))

  return keys.map((key) => {
    const hasBefore = Object.prototype.hasOwnProperty.call(b, key)
    const hasAfter = Object.prototype.hasOwnProperty.call(a, key)
    const valBefore = b[key]
    const valAfter = a[key]

    let status: DiffRow['status'] = 'unchanged'
    if (!hasBefore && hasAfter) {
      status = 'added'
    } else if (hasBefore && !hasAfter) {
      status = 'removed'
    } else if (!areEqual(valBefore, valAfter)) {
      status = 'changed'
    }

    return {
      key,
      label: props.labels[key] ?? key,
      status,
      beforeFormatted: stringifyValue(valBefore),
      afterFormatted: stringifyValue(valAfter),
    }
  }).sort((r1, r2) => {
    // Sort changed/added/removed first, unchanged last
    const order = { changed: 1, added: 2, removed: 3, unchanged: 4 }
    return order[r1.status] - order[r2.status]
  })
})

const visibleRows = computed(() => {
  if (showUnchanged.value) return diffRows.value
  return diffRows.value.filter((row) => row.status !== 'unchanged')
})

const unchangedCount = computed(() => {
  return diffRows.value.filter((row) => row.status === 'unchanged').length
})
</script>

<template>
  <div class="admin-field-diff" data-admin-field-diff>
    <div v-if="diffRows.length === 0" class="admin-field-diff__empty">
      <span>No fields to display</span>
    </div>

    <table v-else class="admin-field-diff__table">
      <thead>
        <tr>
          <th class="admin-field-diff__th admin-field-diff__th--field">Field</th>
          <th class="admin-field-diff__th admin-field-diff__th--before">Published</th>
          <th class="admin-field-diff__th admin-field-diff__th--after">Proposed</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in visibleRows"
          :key="row.key"
          class="admin-field-diff__row"
          :class="[`admin-field-diff__row--${row.status}`]"
          :data-admin-diff-row="row.key"
        >
          <td class="admin-field-diff__cell admin-field-diff__cell--field">
            <span class="admin-field-diff__field-name">{{ row.label }}</span>
            <span
              class="admin-field-diff__tag"
              :class="[`admin-field-diff__tag--${row.status}`]"
            >
              {{ row.status }}
            </span>
          </td>
          <td class="admin-field-diff__cell admin-field-diff__cell--before">
            <span
              v-if="row.status !== 'added'"
              class="admin-field-diff__val admin-field-diff__val--old"
            >
              {{ row.beforeFormatted }}
            </span>
            <span v-else class="admin-field-diff__dash">&mdash;</span>
          </td>
          <td class="admin-field-diff__cell admin-field-diff__cell--after">
            <span
              v-if="row.status !== 'removed'"
              class="admin-field-diff__val admin-field-diff__val--new"
            >
              {{ row.afterFormatted }}
            </span>
            <span v-else class="admin-field-diff__dash">&mdash;</span>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="unchangedCount > 0" class="admin-field-diff__footer">
      <button
        type="button"
        class="admin-field-diff__toggle-btn"
        data-admin-diff-toggle-unchanged
        @click="showUnchanged = !showUnchanged"
      >
        {{ showUnchanged ? 'Hide unchanged fields' : `Show ${unchangedCount} unchanged fields` }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.admin-field-diff {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  border-radius: 10px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.admin-field-diff__empty {
  padding: 16px;
  text-align: center;
  color: #64748b;
  font-size: 0.875rem;
}

.admin-field-diff__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
  text-align: left;
  table-layout: fixed;
}

.admin-field-diff__th {
  padding: 10px 14px;
  font-weight: 600;
  color: #94a3b8;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.admin-field-diff__th--field {
  width: 32%;
}

.admin-field-diff__th--before {
  width: 34%;
}

.admin-field-diff__th--after {
  width: 34%;
}

.admin-field-diff__row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.admin-field-diff__row:last-child {
  border-bottom: none;
}

.admin-field-diff__row--changed {
  background: rgba(234, 179, 8, 0.04);
}

.admin-field-diff__row--added {
  background: rgba(34, 197, 94, 0.05);
}

.admin-field-diff__row--removed {
  background: rgba(239, 68, 68, 0.05);
}

.admin-field-diff__cell {
  padding: 10px 14px;
  vertical-align: top;
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.admin-field-diff__cell--field {
  font-weight: 500;
  color: #e2e8f0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.admin-field-diff__tag {
  font-size: 0.6875rem;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.admin-field-diff__tag--changed {
  background: rgba(234, 179, 8, 0.2);
  color: #facc15;
}

.admin-field-diff__tag--added {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.admin-field-diff__tag--removed {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.admin-field-diff__tag--unchanged {
  background: rgba(100, 116, 139, 0.2);
  color: #94a3b8;
}

.admin-field-diff__val {
  display: inline-block;
  word-break: break-word;
  padding: 2px 6px;
  border-radius: 4px;
}

.admin-field-diff__val--old {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  text-decoration: line-through;
}

.admin-field-diff__val--new {
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
}

.admin-field-diff__dash {
  color: #64748b;
}

.admin-field-diff__footer {
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  text-align: center;
}

.admin-field-diff__toggle-btn {
  background: none;
  border: none;
  color: #38bdf8;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}

.admin-field-diff__toggle-btn:hover {
  text-decoration: underline;
}
</style>
