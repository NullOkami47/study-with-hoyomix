<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { usePreferences } from "../../stores/preferences";
import { chatModerationText } from "./chatModerationText";
import AdminPageHeader from "./primitives/AdminPageHeader.vue";

interface Report {
  id: string;
  messageId: string;
  userId: string | null;
  displayName: string;
  content: string;
  reason: string;
  createdAt: string;
}
interface Ban {
  id: string;
  userId: string;
  displayName: string;
  expiresAt: string | null;
}
interface Filter {
  id: string;
  kind: "literal" | "regex" | "url";
  pattern: string;
  replacement: string;
  enabled: boolean;
}
interface Snapshot {
  viewer: { role: "moderator" | "admin" | "owner" };
  reports: Report[];
  bans: Ban[];
  filters: Filter[];
  intervalMs: number;
}
const { locale } = usePreferences();
const t = (key: Parameters<typeof chatModerationText>[1]) =>
  chatModerationText(locale.value, key);
const data = ref<Snapshot | null>(null);
const busy = ref(false);
const error = ref(false);
const success = ref(false);
const versions = ref<{
  messageId: string;
  original: string;
  entries: { content: string; createdAt: string }[];
} | null>(null);
const reason = ref("");
const intervalMs = ref(1500);
const kind = ref<Filter["kind"]>("literal");
const pattern = ref("");
const replacement = ref("***");
const privileged = computed(
  () =>
    data.value?.viewer.role === "owner" || data.value?.viewer.role === "admin",
);
let active = true;
let controller: AbortController | undefined;

async function load(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = false;
  versions.value = null;
  controller = new AbortController();
  try {
    const response = await fetch("/api/chat/moderation", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("moderation_unavailable");
    const value = (await response.json()) as Snapshot;
    if (
      !value?.viewer ||
      !["moderator", "admin", "owner"].includes(value.viewer.role) ||
      !Array.isArray(value.reports) ||
      !Array.isArray(value.bans) ||
      !Array.isArray(value.filters)
    )
      throw new Error("invalid_snapshot");
    if (!active) return;
    data.value = value;
    intervalMs.value = value.intervalMs;
  } catch {
    if (active) {
      error.value = true;
      data.value = null;
    }
  } finally {
    if (active) busy.value = false;
  }
}

async function mutate(action: Record<string, unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = false;
  success.value = false;
  controller = new AbortController();
  try {
    const response = await fetch("/api/chat/moderation", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) data.value = null;
      throw new Error("moderation_unconfirmed");
    }
    if (!active) return;
    success.value = true;
    busy.value = false;
    await load();
  } catch {
    if (active) error.value = true;
  } finally {
    if (active) busy.value = false;
  }
}

const date = (value: string) =>
  new Intl.DateTimeFormat(locale.value === "en" ? "en-GB" : locale.value, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
async function viewVersions(messageId: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = false;
  controller = new AbortController();
  try {
    const response = await fetch(
      "/api/chat/moderation/messages/" + encodeURIComponent(messageId),
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) data.value = null;
      throw new Error("versions_unavailable");
    }
    const value = (await response.json()) as {
      message: { content: string };
      versions: { content: string; createdAt: string }[];
    };
    if (active)
      versions.value = {
        messageId,
        original: value.message.content,
        entries: value.versions,
      };
  } catch {
    if (active) {
      error.value = true;
      versions.value = null;
    }
  } finally {
    if (active) busy.value = false;
  }
}
const ban = (userId: string, permanent: boolean) =>
  mutate({
    action: "ban",
    userId,
    reason: reason.value,
    expiresAt: permanent
      ? null
      : new Date(Date.now() + 86_400_000).toISOString(),
  });
onMounted(() => {
  void load();
});
onBeforeUnmount(() => {
  active = false;
  controller?.abort();
});
</script>

<template>
  <div class="chat-moderation" data-chat-moderation :aria-busy="busy">
    <AdminPageHeader :title="t('title')" :subtitle="t('description')">
      <template #actions
        ><button type="button" :disabled="busy" @click="load">
          {{ t("retry") }}
        </button></template
      >
    </AdminPageHeader>
    <p v-if="error" role="alert">{{ t("error") }}</p>
    <p v-if="success" role="status">{{ t("saved") }}</p>
    <p v-if="busy && !data" role="status">{{ t("loading") }}</p>
    <template v-if="data">
      <p>{{ t("originals") }}</p>
      <label class="chat-moderation__field"
        >{{ t("reason")
        }}<input
          v-model="reason"
          data-chat-moderation-reason
          maxlength="500"
          :disabled="busy"
      /></label>
      <section :aria-label="t('reports')">
        <h3>{{ t("reports") }}</h3>
        <p v-if="!data.reports.length">{{ t("empty") }}</p>
        <article
          v-for="report in data.reports"
          :key="report.id"
          class="chat-moderation__item"
        >
          <p>
            <strong>{{ report.displayName }}</strong> ·
            <time>{{ date(report.createdAt) }}</time>
          </p>
          <p class="chat-moderation__content">{{ report.content }}</p>
          <p>{{ report.reason }}</p>
          <div class="chat-moderation__actions">
            <button
              type="button"
              data-chat-moderation-versions
              :disabled="busy"
              @click="viewVersions(report.messageId)"
            >
              {{ t("viewVersions") }}
            </button>
            <button
              type="button"
              data-chat-moderation-delete
              :disabled="busy || !reason.trim()"
              @click="
                mutate({
                  action: 'delete',
                  messageId: report.messageId,
                  reason,
                })
              "
            >
              {{ t("delete") }}
            </button>
            <button
              type="button"
              :disabled="busy || !reason.trim()"
              @click="
                mutate({ action: 'resolve', reportId: report.id, reason })
              "
            >
              {{ t("resolve") }}
            </button>
            <button
              v-if="report.userId"
              type="button"
              :disabled="busy || !reason.trim()"
              @click="ban(report.userId, false)"
            >
              {{ t("temporary") }}
            </button>
            <button
              v-if="report.userId"
              type="button"
              :disabled="busy || !reason.trim()"
              @click="ban(report.userId, true)"
            >
              {{ t("permanent") }}
            </button>
          </div>
          <section
            v-if="versions?.messageId === report.messageId"
            :aria-label="t('versions')"
          >
            <h4>{{ t("versions") }}</h4>
            <p class="chat-moderation__content">{{ versions.original }}</p>
            <div v-for="(entry, index) in versions.entries" :key="index">
              <time>{{ date(entry.createdAt) }}</time>
              <p class="chat-moderation__content">{{ entry.content }}</p>
            </div>
          </section>
        </article>
      </section>
      <section :aria-label="t('bans')">
        <h3>{{ t("bans") }}</h3>
        <p v-if="!data.bans.length">{{ t("noBans") }}</p>
        <div
          v-for="item in data.bans"
          :key="item.id"
          class="chat-moderation__item"
        >
          <p>
            {{ item.displayName }} ·
            {{ item.expiresAt ? date(item.expiresAt) : t("forever") }}
          </p>
          <button
            type="button"
            :disabled="busy || !reason.trim()"
            @click="mutate({ action: 'unban', userId: item.userId, reason })"
          >
            {{ t("unban") }}
          </button>
        </div>
      </section>
      <form
        v-if="privileged"
        data-chat-moderation-settings
        @submit.prevent="mutate({ action: 'settings', intervalMs })"
      >
        <h3>{{ t("settings") }}</h3>
        <label class="chat-moderation__field"
          >{{ t("interval")
          }}<input
            v-model.number="intervalMs"
            type="number"
            min="250"
            max="60000"
            step="1"
            required
        /></label>
        <button :disabled="busy" type="submit">{{ t("save") }}</button>
      </form>
      <section
        v-if="privileged"
        data-chat-moderation-filters
        :aria-label="t('filters')"
      >
        <h3>{{ t("filters") }}</h3>
        <p v-if="!data.filters.length">{{ t("noFilters") }}</p>
        <div
          v-for="rule in data.filters"
          :key="rule.id"
          class="chat-moderation__item"
        >
          <p>
            {{ t(rule.kind) }}: <code>{{ rule.pattern }}</code> →
            {{ rule.replacement }}
          </p>
          <button
            type="button"
            :disabled="busy"
            @click="
              mutate({ action: 'remove_filter', filter: { id: rule.id } })
            "
          >
            {{ t("remove") }}
          </button>
        </div>
        <form
          class="chat-moderation__form"
          @submit.prevent="
            mutate({
              action: 'filter',
              filter: { kind, pattern, replacement, enabled: true },
            })
          "
        >
          <label class="chat-moderation__field"
            >{{ t("kind")
            }}<select v-model="kind">
              <option value="literal">{{ t("literal") }}</option>
              <option value="regex">{{ t("regex") }}</option>
              <option value="url">{{ t("url") }}</option>
            </select></label
          >
          <label class="chat-moderation__field"
            >{{ t("pattern")
            }}<input v-model="pattern" maxlength="120" required
          /></label>
          <label class="chat-moderation__field"
            >{{ t("replacement") }}<input v-model="replacement" readonly
          /></label>
          <button type="submit" :disabled="busy || !pattern.trim()">
            {{ t("add") }}
          </button>
        </form>
      </section>
    </template>
  </div>
</template>

<style scoped>
.chat-moderation {
  display: grid;
  gap: 1rem;
  min-width: 0;
  color: var(--colour-text-primary);
}
.chat-moderation p {
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.5;
  font-size: 0.875rem;
}
.chat-moderation section,
.chat-moderation form {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.chat-moderation h3 {
  margin: 0.5rem 0 0;
  font-size: 1rem;
}
.chat-moderation__item {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border-block-end: 1px solid var(--liquid-separator);
}
.chat-moderation__field {
  display: grid;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.chat-moderation__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.chat-moderation__content {
  white-space: pre-wrap;
}
.chat-moderation button,
.chat-moderation input,
.chat-moderation select {
  box-sizing: border-box;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: 1px solid var(--liquid-separator);
  border-radius: var(--liquid-radius-control);
  font: inherit;
  max-width: 100%;
}
.chat-moderation button {
  cursor: pointer;
}
.chat-moderation input {
  width: 100%;
}
.chat-moderation :focus-visible {
  outline: 2px solid var(--colour-focus);
  outline-offset: 2px;
}
.chat-moderation button:disabled {
  opacity: 0.6;
  cursor: default;
}
.chat-moderation time {
  color: var(--colour-text-muted);
}
</style>
