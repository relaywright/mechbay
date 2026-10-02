import { describe, it, expect } from 'vitest'
import { QUICK_PROMPTS, filterPromptsFor, getPromptById } from '../../src/renderer/src/quickPrompts'

describe('quickPrompts library', () => {
  describe('QUICK_PROMPTS', () => {
    it('contains at least 8 default prompts', () => {
      expect(QUICK_PROMPTS.length).toBeGreaterThanOrEqual(8)
    })

    it('includes a custom sentinel with empty prompt', () => {
      const custom = QUICK_PROMPTS.find((p) => p.id === 'custom')
      expect(custom).toBeDefined()
      expect(custom?.label).toBe('Custom')
      expect(custom?.prompt).toBe('')
    })

    it('all prompts have required fields', () => {
      for (const prompt of QUICK_PROMPTS) {
        expect(prompt.id).toBeDefined()
        expect(prompt.id.length).toBeGreaterThan(0)
        expect(prompt.label).toBeDefined()
        expect(prompt.label.length).toBeGreaterThan(0)
        expect(prompt.prompt).toBeDefined() // can be empty for custom
      }
    })

    it('all IDs are unique', () => {
      const ids = QUICK_PROMPTS.map((p) => p.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe('filterPromptsFor', () => {
    it('returns all prompts when no filters match (empty mechClass/facilityType)', () => {
      const result = filterPromptsFor('atlas', 'foundry')
      // Most prompts have no filters, so they should all be included
      expect(result.length).toBeGreaterThanOrEqual(8)
    })

    it('always includes the custom sentinel regardless of filters', () => {
      const result = filterPromptsFor('raven', 'security-bay')
      const custom = result.find((p) => p.id === 'custom')
      expect(custom).toBeDefined()
    })

    it('filters by mechClass when specified', () => {
      // First, find a prompt with mechClass filter
      const filteredPrompt = QUICK_PROMPTS.find((p) => p.mechClass && p.mechClass.length > 0)

      if (filteredPrompt) {
        const allowedClasses = filteredPrompt.mechClass!
        const allowedClass = allowedClasses[0]
        // Pick a class that's definitely NOT in the allowed list
        const allClasses = ['atlas', 'marauder', 'raven', 'catapult', 'locust']
        const blockedClass = allClasses.find((c) => !allowedClasses.includes(c))!

        const allowedResult = filterPromptsFor(allowedClass, 'foundry')
        const blockedResult = filterPromptsFor(blockedClass, 'foundry')

        expect(allowedResult.find((p) => p.id === filteredPrompt.id)).toBeDefined()
        expect(blockedResult.find((p) => p.id === filteredPrompt.id)).toBeUndefined()
      }
    })

    it('filters by facilityType when specified', () => {
      // Find a prompt with facilityType filter
      const filteredPrompt = QUICK_PROMPTS.find((p) => p.facilityType && p.facilityType.length > 0)

      if (filteredPrompt) {
        const allowedTypes = filteredPrompt.facilityType!
        const allowedType = allowedTypes[0]
        // Pick a type that's definitely NOT in the allowed list
        const allTypes = [
          'security-bay',
          'research-lab',
          'foundry',
          'command-center',
          'salvage-dock',
          'data-archive'
        ]
        const blockedType = allTypes.find((t) => !allowedTypes.includes(t))!

        const allowedResult = filterPromptsFor('raven', allowedType)
        const blockedResult = filterPromptsFor('raven', blockedType)

        expect(allowedResult.find((p) => p.id === filteredPrompt.id)).toBeDefined()
        expect(blockedResult.find((p) => p.id === filteredPrompt.id)).toBeUndefined()
      }
    })

    it('handles empty mechClass gracefully', () => {
      const result = filterPromptsFor('', 'command-center')
      // Custom should always be present
      expect(result.find((p) => p.id === 'custom')).toBeDefined()
    })

    it('handles all facility types without crashing', () => {
      const facilityTypes = [
        'security-bay',
        'research-lab',
        'foundry',
        'command-center',
        'salvage-dock',
        'data-archive'
      ]

      for (const facilityType of facilityTypes) {
        const result = filterPromptsFor('atlas', facilityType)
        expect(result.length).toBeGreaterThanOrEqual(1)
        // Custom always present
        expect(result.find((p) => p.id === 'custom')).toBeDefined()
      }
    })

    it('handles all mech classes without crashing', () => {
      const mechClasses = ['atlas', 'marauder', 'raven', 'catapult', 'locust']

      for (const mechClass of mechClasses) {
        const result = filterPromptsFor(mechClass, 'research-lab')
        expect(result.length).toBeGreaterThanOrEqual(1)
        expect(result.find((p) => p.id === 'custom')).toBeDefined()
      }
    })
  })

  describe('getPromptById', () => {
    it('returns the correct prompt for valid IDs', () => {
      for (const prompt of QUICK_PROMPTS) {
        const found = getPromptById(prompt.id)
        expect(found).toBeDefined()
        expect(found?.id).toBe(prompt.id)
        expect(found?.label).toBe(prompt.label)
      }
    })

    it('returns undefined for unknown IDs', () => {
      expect(getPromptById('nonexistent')).toBeUndefined()
      expect(getPromptById('')).toBeUndefined()
    })

    it('finds the custom sentinel', () => {
      const custom = getPromptById('custom')
      expect(custom).toBeDefined()
      expect(custom?.icon).toBe('✏️')
    })
  })
})
