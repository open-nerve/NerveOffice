import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function auditFixtures(root) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1, 'manifest schema')
  assert(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'cases must not be empty')
  const ids = new Set()
  for (const row of manifest.cases) {
    assert(typeof row.id === 'string' && !ids.has(row.id), 'duplicate or missing case identity')
    ids.add(row.id)
    assert(typeof row.file === 'string' && /^[\w.-]+$/.test(row.file) && !row.file.startsWith('.'), 'invalid fixture path')
    assert(row.expected && ['accept', 'reject'].includes(row.expected.status), 'missing expectation')
    assert(typeof row.declaredType === 'string' && typeof row.extension === 'string', 'missing declared input type')
    const file = join(root, row.file)
    assert((await lstat(file)).isFile(), 'fixture path is not a regular file')
    const bytes = await readFile(file)
    assert.equal(bytes.length, row.bytes, `${row.id}: size mismatch`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, `${row.id}: digest mismatch`)
  }
  return manifest.cases
}
