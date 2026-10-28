import { expect, test } from 'claude-code/testing'
import { DEFAULTS, readConfig, splitList } from '../hooks/policy.ts'

test('readConfig keeps defaults and takes overrides', () => {
  const c = readConfig({ injection: 0.5, doneCheck: false })
  expect(c.injection).toBe(0.5)
  expect(c.doneCheck).toBe(false)
  expect(c.bashIrreversible).toBe(0.6)
  expect(DEFAULTS.injection).toBe(0.7)
})

test('splitList splits on ; and trims', () => {
  expect(splitList(' ~/.claude ; $TMPDIR;;/tmp ')).toEqual(['~/.claude', '$TMPDIR', '/tmp'])
  expect(splitList('')).toEqual([])
})


test('blocking gates require an explicit lockdown opt-in, even with old gate settings', () => {
  const c = readConfig({ bashGate: true, writeGate: true, exfilGate: true, doneCheck: true })
  expect(c.lockdown).toBe(false)
  expect(c.githubReminders).toBe(true)
  expect(readConfig({ lockdown: true }).lockdown).toBe(true)
})
