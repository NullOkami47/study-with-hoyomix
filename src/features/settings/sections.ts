/**
 * The Settings sections, named once so the sheet and the Control Center cannot drift.
 *
 * The sheet renders every section when it is given no subset, which is the standalone
 * behaviour it has always had. The Control Center passes a subset per category, so a
 * category is a view onto this list rather than a second copy of the settings model.
 */
export const SETTINGS_SECTION_IDS = [
  'language',
  'appearance',
  'pomodoro',
  'playback',
  'library',
  'account',
  'application',
  'about',
  'privacy',
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]
