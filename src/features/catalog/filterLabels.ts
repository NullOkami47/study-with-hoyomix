import type { RelationKind } from './types'
import { translate, type Locale, type TranslationKey } from '../../i18n'

const relationKey: Record<RelationKind, TranslationKey> = {
  character: 'relation.character', npc: 'relation.npc', place: 'relation.place', faction: 'relation.faction', event: 'relation.event',
}

export function relationLabel(relation: string, locale: Locale): string {
  const [kind, ...idParts] = relation.split(':') as [RelationKind, ...string[]]
  const id = idParts.join(':').split(/[-_]/u).filter(Boolean).map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1)).join(' ')
  return translate(locale, 'catalog.relationLabel', { kind: translate(locale, relationKey[kind]), id })
}
