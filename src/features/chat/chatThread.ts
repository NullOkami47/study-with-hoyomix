/**
 * Presentation rules for the chat log: which messages share one header, how an author's
 * avatar looks when there is no picture, and how a quoted message is summarised.
 *
 * Grouping, the reply quote, the unread jump control and scroll restoration follow the chat
 * room of StudyWithMiku (https://github.com/shshouse/StudyWithMiku, GPL-3.0, by shshouse),
 * reimplemented for this project's protocol, locales and Liquid Glass styling.
 */
import type { ChatMessage } from './client'

/** Consecutive messages from one author within this window share a header. */
export const CHAT_GROUP_WINDOW_MS = 10 * 60_000
/** Quoted text is cut to this many user-perceived characters. */
export const CHAT_SUMMARY_LENGTH = 40

export interface ChatMessageGroup {
  key: string
  messages: ChatMessage[]
}

function sameHeader(previous: ChatMessage, next: ChatMessage): boolean {
  // A deleted account has no user id. Its messages never merge, because two different
  // deleted authors would otherwise be shown as one person. Location is chosen per message
  // and shown once per header, so a change of location starts a new header.
  return previous.userId !== null && previous.userId === next.userId &&
    (previous.location ?? null) === (next.location ?? null) &&
    previous.role === next.role
}

export function groupChatMessages(messages: readonly ChatMessage[]): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = []
  let current: ChatMessageGroup | undefined
  for (const message of messages) {
    const last = current?.messages.at(-1)
    const gap = last ? Date.parse(message.createdAt) - Date.parse(last.createdAt) : Infinity
    if (current && last && sameHeader(last, message) && gap >= 0 && gap <= CHAT_GROUP_WINDOW_MS) {
      current.messages.push(message)
    } else {
      current = { key: message.id, messages: [message] }
      groups.push(current)
    }
  }
  return groups
}

function graphemes(value: string): string[] {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>
    }
  }).Segmenter
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map((part) => part.segment)
  return Array.from(value)
}

/** The first user-perceived character of a name, so an emoji or accented letter is not split. */
export function avatarInitial(name: string): string {
  const first = graphemes(name.trim())[0]
  return first ? first.toLocaleUpperCase() : '?'
}

/** Twelve hues spaced around the wheel; the same author always gets the same one. */
export function avatarHue(seed: string): number {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0
  }
  return (Math.abs(hash) % 12) * 30
}

export function truncateSummary(value: string, length = CHAT_SUMMARY_LENGTH): string {
  const parts = graphemes(value.replace(/\s+/gu, ' ').trim())
  return parts.length > length ? `${parts.slice(0, length).join('')}…` : parts.join('')
}
