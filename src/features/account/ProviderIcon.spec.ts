import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ProviderIcon from './ProviderIcon.vue'

describe('ProviderIcon', () => {
  it('renders official 4-color Google G mark for google provider', () => {
    const wrapper = mount(ProviderIcon, { props: { provider: 'google' } })
    const svg = wrapper.find('svg.auth-icon--google')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('focusable')).toBe('false')
    // 4 official brand color paths: blue, green, yellow, red
    const paths = svg.findAll('path')
    expect(paths).toHaveLength(4)
    expect(paths.map((p) => p.attributes('fill'))).toEqual([
      '#4285F4',
      '#34A853',
      '#FBBC05',
      '#EA4335',
    ])
  })

  it('renders official GitHub Octocat mark for github provider', () => {
    const wrapper = mount(ProviderIcon, { props: { provider: 'github' } })
    const svg = wrapper.find('svg.auth-icon--github')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('fill')).toBe('currentColor')
    expect(svg.find('path').exists()).toBe(true)
  })

  it('renders official LINUX DO circular tricolor emblem for linuxdo provider', () => {
    const wrapper = mount(ProviderIcon, { props: { provider: 'linuxdo' } })
    const svg = wrapper.find('svg.auth-icon--linuxdo')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('viewBox')).toBe('0 0 512 512')
    // Outer disc and 2 horizontal segment paths
    expect(svg.find('circle').attributes('fill')).toBe('#efefef')
    const paths = svg.findAll('path')
    expect(paths).toHaveLength(2)
    expect(paths[0].attributes('fill')).toBe('#1e1e20')
    expect(paths[1].attributes('fill')).toBe('#feb005')
  })
})
