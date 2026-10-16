import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AdminFieldDiff from './AdminFieldDiff.vue'

describe('AdminFieldDiff', () => {
  it('renders diff rows with changed, added, and removed statuses', () => {
    const before = { title: 'Old Title', album: 'Same Album', deletedField: 'To be removed' }
    const after = { title: 'New Title', album: 'Same Album', addedField: 'Brand new' }

    const wrapper = mount(AdminFieldDiff, {
      props: {
        before,
        after,
      },
    })

    // By default, unchanged rows are hidden
    expect(wrapper.find('[data-admin-diff-row="album"]').exists()).toBe(false)

    // Changed row
    const titleRow = wrapper.get('[data-admin-diff-row="title"]')
    expect(titleRow.text()).toContain('changed')
    expect(titleRow.find('.admin-field-diff__val--old').text()).toBe('Old Title')
    expect(titleRow.find('.admin-field-diff__val--new').text()).toBe('New Title')

    // Added row
    const addedRow = wrapper.get('[data-admin-diff-row="addedField"]')
    expect(addedRow.text()).toContain('added')
    expect(addedRow.find('.admin-field-diff__val--new').text()).toBe('Brand new')

    // Removed row
    const removedRow = wrapper.get('[data-admin-diff-row="deletedField"]')
    expect(removedRow.text()).toContain('removed')
    expect(removedRow.find('.admin-field-diff__val--old').text()).toBe('To be removed')
  })

  it('toggles unchanged fields when clicking toggle button', async () => {
    const before = { album: 'Same Album' }
    const after = { album: 'Same Album' }

    const wrapper = mount(AdminFieldDiff, {
      props: {
        before,
        after,
      },
    })

    expect(wrapper.find('[data-admin-diff-row="album"]').exists()).toBe(false)
    const toggleBtn = wrapper.get('[data-admin-diff-toggle-unchanged]')
    expect(toggleBtn.text()).toContain('Show 1 unchanged')

    await toggleBtn.trigger('click')
    expect(wrapper.find('[data-admin-diff-row="album"]').exists()).toBe(true)
  })

  it('respects custom field labels and exclusion list', () => {
    const before = { secret_token: '123', custom_field: 'A' }
    const after = { secret_token: '456', custom_field: 'B' }

    const wrapper = mount(AdminFieldDiff, {
      props: {
        before,
        after,
        labels: { custom_field: 'Custom Label' },
        exclude: ['secret_token'],
      },
    })

    expect(wrapper.find('[data-admin-diff-row="secret_token"]').exists()).toBe(false)
    const customRow = wrapper.get('[data-admin-diff-row="custom_field"]')
    expect(customRow.text()).toContain('Custom Label')
  })
})
