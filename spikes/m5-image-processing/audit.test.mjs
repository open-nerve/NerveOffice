import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { auditFixtures } from './audit.mjs'

async function fixture(t, change = value => value) {
  const root = await mkdtemp(join(tmpdir(), 'nerve-image-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from('controlled fixture')
  await writeFile(join(root, 'sample.bin'), bytes)
  const row = { id: 'sample', file: 'sample.bin', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, declaredType: 'image/png', extension: 'png', expected: { status: 'reject', reason: 'type' } }
  const manifest = change({ schemaVersion: 1, cases: [row] })
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, row }
}

test('returns the actual verified cases', async (t) => {
  const { root, row } = await fixture(t)
  assert.deepEqual(await auditFixtures(root), [row])
})

for (const [name, change, message] of [
  ['digest mismatch', m => { m.cases[0].sha256 = '0'.repeat(64); return m }, /digest/],
  ['size mismatch', m => { m.cases[0].bytes++; return m }, /size/],
  ['path escape', m => { m.cases[0].file = '../outside.bin'; return m }, /path/],
  ['duplicate identity', m => { m.cases.push({ ...m.cases[0] }); return m }, /duplicate/],
  ['missing expectation', m => { delete m.cases[0].expected; return m }, /expectation/],
  ['empty matrix', m => { m.cases = []; return m }, /cases/],
]) {
  test(`rejects ${name}`, async (t) => {
    const { root } = await fixture(t, change)
    await assert.rejects(auditFixtures(root), message)
  })
}

test('rejects a missing sample', async (t) => {
  const { root } = await fixture(t)
  await rm(join(root, 'sample.bin'))
  await assert.rejects(auditFixtures(root), /ENOENT/)
})
