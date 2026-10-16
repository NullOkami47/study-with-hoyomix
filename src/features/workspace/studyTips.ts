import { translate, type Locale, type TranslationKey } from '../../i18n'
export type StudyTipId = 'pace' | 'reset' | 'environment'
export interface StudyTip { id: StudyTipId; title: string; body: string }
const ids: readonly StudyTipId[] = ['pace', 'reset', 'environment']
export function getStudyTip(locale: Locale, index: number): StudyTip {
  const id = ids[Math.abs(Math.trunc(index)) % ids.length]!
  return {
    id,
    title: translate(locale, `studyTips.${id}.title` as TranslationKey),
    body: translate(locale, `studyTips.${id}.body` as TranslationKey),
  }
}
