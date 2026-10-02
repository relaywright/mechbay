/**
 * Quick-prompt chip library for DeployModal.
 *
 * Provides a typed collection of pre-written task prompts that can be
 * filtered by mech class and facility type. Each prompt is designed
 * to cover common deployment scenarios across the MechBay ecosystem.
 */

export interface QuickPrompt {
  id: string
  label: string // short button text, 2-3 words
  prompt: string // the actual prompt sent to the agent
  mechClass?: string[] // optional: only show for these mech classes (e.g. ['scout'])
  facilityType?: string[] // optional: only show for these facility types
  icon?: string // optional unicode icon prefix
}

/**
 * Default quick-prompt library covering common mech/facility combos.
 * Includes an "✏️ Custom" sentinel for free-form input.
 */
export const QUICK_PROMPTS: QuickPrompt[] = [
  {
    id: 'explore',
    label: 'Explore',
    icon: '🔍',
    prompt:
      'Explore this codebase. Start with README + package.json + top-level directories. Report what you find including: project purpose, tech stack, entry points, and any obvious issues.'
  },
  {
    id: 'debug-error',
    label: 'Debug Error',
    icon: '🐛',
    prompt:
      'Read the most recent error logs. Trace root cause. Propose minimal fix with clear explanation of what went wrong.'
  },
  {
    id: 'add-tests',
    label: 'Add Tests',
    icon: '✨',
    prompt:
      "Add unit tests for the most under-tested module. Use the project's existing test framework. Aim for meaningful coverage of edge cases."
  },
  {
    id: 'docs-pass',
    label: 'Docs Pass',
    icon: '📚',
    prompt:
      'Read recent commits. Update CHANGELOG.md and TODO.md to reflect current state. Ensure documentation matches implementation.'
  },
  {
    id: 'security-audit',
    label: 'Audit Security',
    icon: '🔎',
    prompt:
      'Quick security audit. Check for secrets in code, unsafe eval, SQL injection, prototype pollution. Report findings with severity ratings.'
  },
  {
    id: 'refactor-cleanup',
    label: 'Refactor',
    icon: '🧹',
    prompt:
      'Identify the messiest module. Refactor for clarity without changing behavior. Focus on naming, function size, and dead code removal.'
  },
  {
    id: 'performance-check',
    label: 'Performance',
    icon: '⚡',
    prompt:
      'Profile the hot paths. Identify bottlenecks. Suggest optimizations with expected impact. Do not change behavior, only speed.'
  },
  {
    id: 'dependency-review',
    label: 'Dependencies',
    icon: '📦',
    prompt:
      'Review package.json dependencies. Flag outdated, unused, or vulnerable packages. Suggest specific version updates with rationale.'
  },
  {
    id: 'api-consistency',
    label: 'API Check',
    icon: '🔌',
    prompt:
      'Audit API endpoints for consistency. Check error handling, status codes, and response shapes. Flag inconsistencies and suggest fixes.'
  },
  {
    id: 'type-coverage',
    label: 'Type Safety',
    icon: '🔒',
    prompt:
      "Find the most type-unsafe areas. Add TypeScript types or JSDoc. Eliminate any's that can be properly typed. Do not change runtime behavior."
  },
  {
    id: 'accessibility-pass',
    label: 'A11y Pass',
    icon: '♿',
    facilityType: ['command-center', 'research-lab'],
    prompt:
      'Audit UI components for accessibility. Check ARIA labels, keyboard navigation, color contrast. Provide specific fixes.'
  },
  {
    id: 'custom',
    label: 'Custom',
    icon: '✏️',
    prompt: '' // Sentinel: user writes their own prompt
  }
]

/**
 * Filter quick prompts for a specific mech class and facility type.
 *
 * Rules:
 * - If mechClass is provided, only include prompts that either have no mechClass filter
 *   or include the specified mechClass.
 * - If facilityType is provided, only include prompts that either have no facilityType filter
 *   or include the specified facilityType.
 * - The "custom" sentinel is always included.
 *
 * @param mechClass - The mech class to filter for (e.g., 'raven', 'atlas')
 * @param facilityType - The facility type to filter for (e.g., 'research-lab', 'foundry')
 * @returns Filtered array of QuickPrompts appropriate for this deployment
 */
export function filterPromptsFor(mechClass: string, facilityType: string): QuickPrompt[] {
  return QUICK_PROMPTS.filter((prompt) => {
    // Custom sentinel is always shown
    if (prompt.id === 'custom') return true

    // Check mechClass filter if present
    if (prompt.mechClass && prompt.mechClass.length > 0) {
      if (!prompt.mechClass.includes(mechClass)) return false
    }

    // Check facilityType filter if present
    if (prompt.facilityType && prompt.facilityType.length > 0) {
      if (!prompt.facilityType.includes(facilityType)) return false
    }

    return true
  })
}

/**
 * Get a single quick prompt by ID.
 *
 * @param id - The prompt ID to look up
 * @returns The QuickPrompt or undefined if not found
 */
export function getPromptById(id: string): QuickPrompt | undefined {
  return QUICK_PROMPTS.find((p) => p.id === id)
}
