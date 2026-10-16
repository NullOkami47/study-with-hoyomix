import type { TranslationKey } from '../../i18n'

const repository = 'https://github.com/NullOkami47/study-with-hoyomix'
type DisclosureLink = { label: TranslationKey; href: string }

export const aboutLinks: readonly DisclosureLink[] = [
  { label: 'settings.about.repositoryLink', href: repository },
  { label: 'settings.about.licenceLink', href: '/legal/licence.txt' },
  { label: 'settings.about.noticesLink', href: '/legal/third-party-notices.txt' },
  { label: 'settings.about.upstreamLink', href: 'https://github.com/shshouse/StudyWithMiku' },
  { label: 'settings.about.glassLink', href: '/legal/liquid-glass-notice.txt' },
]

export const privacyLinks: readonly DisclosureLink[] = [
  { label: 'settings.privacy.googleLink', href: 'https://policies.google.com/privacy' },
  { label: 'settings.privacy.githubLink', href: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement' },
  { label: 'settings.privacy.linuxdoLink', href: 'https://linux.do/privacy' },
]
