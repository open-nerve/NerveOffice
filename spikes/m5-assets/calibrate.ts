import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { nativeEvidenceOf } from './src/record.ts'

const require = createRequire(resolve(import.meta.dirname, '../../tests/e2e/package.json'))
const { chromium, webkit } = require('@playwright/test')
const { values } = parseArgs({ options: { origin: { type: 'string' }, output: { type: 'string' } } })
if (!values.origin || new URL(values.origin).hostname !== '127.0.0.1' || !values.output)
  throw new Error('需要 --origin http://127.0.0.1:<端口> 和 --output')
const origin = values.origin
const output = resolve(values.output)
if (existsSync(output)) throw new Error('拒绝覆盖已有校准结果')
mkdirSync(output, { recursive: true })
const health = await (await fetch(`${origin}/health`)).json() as { buildId: string }
const results: unknown[] = []
for (const [browserName, launcher, options] of [['chromium', chromium, {}], ['chrome', chromium, { channel: 'chrome' }], ['webkit', webkit, {}]] as const) {
  const browser = await launcher.launch({ headless: true, ...options })
  try {
    for (const mode of ['default', 'diagnostic']) {
      const caseId = `${browserName}-${mode}`
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
      const page = await context.newPage()
      const errors: string[] = []
      const blocked: string[] = []
      page.on('pageerror', (error: Error) => errors.push(String(error)))
      await page.route('**/*', (route: any) => {
        const url = route.request().url()
        if (url.startsWith(`${origin}/`)) return route.continue()
        blocked.push(url); return route.abort()
      })
      try {
        await page.goto(`${origin}/?run=calibration&case=${caseId}&mode=${mode}&method=synthetic&drop=1&copy=1`)
        await page.waitForFunction(() => (window as any).__m5Probe?.records.some((record: any) => ['ready', 'boot-error'].includes(record.type)))
        const initial = await page.evaluate(() => (window as any).__m5Probe.records)
        assert.equal(initial.some((record: any) => record.type === 'boot-error'), false, JSON.stringify(initial))
        assert.ok(initial.some((record: any) => record.type === 'ready' && record.sdkVersion === '1.0.1' && record.buildId === health.buildId))
        const inserted = await page.evaluate(() => (window as any).__m5Probe.insertFixture('sample.png'))
        assert.equal(inserted, true)
        await page.waitForFunction(() => (window as any).__m5Probe.state().drawingCount === 1)
        await page.evaluate(async () => {
          const blob = await (await fetch('/fixtures/sample.png')).blob()
          const data = new DataTransfer()
          data.items.add(new File([blob], 'sample.png', { type: 'image/png' }))
          data.setData('text/html', '<img src="/fixtures/sample.png">')
          document.querySelector('#receiver')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        })
        await page.waitForFunction(() => (window as any).__m5Probe.records.some((record: any) => record.type === 'file-digests' && record.target === 'receiver'))
        const dropped = await page.evaluate(async () => {
          const blob = await (await fetch('/fixtures/sample.png')).blob()
          const data = new DataTransfer(); data.items.add(new File([blob], 'sample.png', { type: 'image/png' }))
          const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
          document.querySelector('#sheet canvas')!.dispatchEvent(event)
          return event.defaultPrevented
        })
        assert.equal(dropped, mode === 'diagnostic')
        if (mode === 'diagnostic') await page.waitForFunction(() => (window as any).__m5Probe.state().drawingCount === 2)
        await page.waitForFunction(() => (window as any).__m5Probe.records.some((record: any) => record.type === 'file-digests' && record.target === 'sheet'))
        if (mode === 'diagnostic') {
          // SDK 的复制快捷键直接调用异步 Clipboard API，不保证产生 DOM copy 事件。
          await page.evaluate(() => document.querySelector('#sheet')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true })))
          await page.waitForFunction(() => (window as any).__m5Probe.records.some((record: any) => record.type === 'diagnostic-copy-scheduled' && record.details.origin === 'keyboard'), null, { timeout: 3000 })
          await page.waitForFunction(() => (window as any).__m5Probe.records.some((record: any) => record.type === 'diagnostic-copy'), null, { timeout: 3000 })
        }
        const state = await page.evaluate(() => ({ record: (window as any).__m5Probe.state(), records: (window as any).__m5Probe.records }))
        assert.equal(state.record.details.images[0].sourceType, mode === 'default' ? 'BASE64' : 'URL', '种子图片必须保持默认 SDK 与诊断 IO 各自的来源类型，否则复制对照失真')
        const paste = state.records.find((record: any) => record.type === 'paste')
        assert.equal(paste.isTrusted, false)
        assert.equal(paste.method, 'synthetic')
        assert.ok(paste.types.includes('text/html') && paste.files[0].type === 'image/png')
        assert.ok(state.records.some((record: any) => record.type === 'file-digests' && record.files[0].sha256 === 'c38d9b030b0952e4446cdde399d6cd1f764d525bcd278987efa77b442c8081b2'))
        assert.equal(nativeEvidenceOf(state.records, null).eligible, false)
        assert.equal(state.record.drawingCount, mode === 'diagnostic' ? 2 : 1)
        assert.deepEqual(errors, [])
        assert.deepEqual(blocked, [])
        const unexpected = state.records.filter((record: any) => record.type === 'csp-violation' || record.error && !(record.type === 'diagnostic-copy' && record.error.startsWith('NotAllowedError')))
        assert.deepEqual(unexpected, [], JSON.stringify(unexpected))
        await page.screenshot({ path: join(output, `${caseId}.png`), fullPage: true })
        writeFileSync(join(output, `${caseId}.json`), `${JSON.stringify({ browserName, version: browser.version(), mode, ...state, errors, blocked }, null, 2)}\n`)
        results.push({ caseId, passed: true, drawingCount: state.record.drawingCount })
        console.log(`${caseId}: PASS`)
      }
      catch (error) {
        writeFileSync(join(output, `${caseId}-failure.json`), JSON.stringify({ error: String(error), errors, blocked, records: await page.evaluate(() => (window as any).__m5Probe?.records).catch(() => null) }, null, 2))
        await page.screenshot({ path: join(output, `${caseId}-failure.png`), fullPage: true }).catch(() => {})
        throw error
      }
      finally { await context.tracing.stop({ path: join(output, `${caseId}-trace.zip`) }); await context.close() }
    }
  }
  finally { await browser.close() }
}
assert.equal((await fetch(`${origin}/records`, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
assert.equal((await fetch(`${origin}/records`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, buildId: 'wrong', sdkVersion: '1.0.1', seq: 1, runId: 'calibration' }) })).status, 400)
assert.equal((await fetch(`${origin}/probe-images`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: 'not an image' })).status, 415)
writeFileSync(join(output, 'summary.json'), `${JSON.stringify({ buildId: health.buildId, method: 'synthetic', nativeEvidence: false, results, serverChecks: 3 }, null, 2)}\n`)
