import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeEvidenceOf } from './src/record.ts'

const record = {
  schemaVersion: 1,
  runId: 'chrome-native-1',
  caseId: 'web-copy-png',
  pageId: 'page-1',
  buildId: 'build-1',
  sdkVersion: '1.0.1',
  userAgent: 'controlled-browser',
  mode: 'default',
  method: 'native-ui',
  seq: 2,
  at: '2026-10-18T12:00:01.000Z',
  type: 'paste',
  target: 'sheet',
  isTrusted: true,
  defaultPrevented: false,
  types: ['text/html', 'image/png'],
  files: [{ type: 'image/png', size: 12, sha256: 'a'.repeat(64) }],
  drawingCount: 0,
  error: null,
}
const receipt = {
  method: 'cua',
  runId: 'chrome-native-1',
  caseId: 'web-copy-png',
  pageId: 'page-1',
  buildId: 'build-1',
  sdkVersion: '1.0.1',
  userAgent: 'controlled-browser',
  mode: 'default',
  startedAt: '2026-10-18T12:00:00.000Z',
  finishedAt: '2026-10-18T12:00:02.000Z',
  actionRef: 'native-chrome/actions/02-paste.json',
  source: { kind: 'controlled-page', fixtureIds: ['sample.png'], proof: 'native-chrome/actions/01-copy.json' },
  eventSequences: [2],
}

test('完整原生动作回执允许引用事件证据，但零张图片仍不能被推断成功', () => {
  assert.deepEqual(nativeEvidenceOf([record], receipt), { eligible: true, reasons: [] })
})

for (const [name, patch] of [
  ['合成粘贴', { method: 'synthetic' }],
  ['协议输入的可信事件', { method: 'protocol' }],
  ['伪称原生但非可信', { isTrusted: false }],
  ['另一轮运行', { runId: 'other' }],
  ['另一项测试', { caseId: 'other' }],
  ['旧页面', { pageId: 'old-page' }],
  ['另一份构建', { buildId: 'other-build' }],
  ['旧 SDK', { sdkVersion: '1.0.0' }],
  ['另一浏览器', { userAgent: 'other-browser' }],
  ['另一诊断模式', { mode: 'diagnostic' }],
  ['回执之前的旧事件', { at: '2026-10-18T11:59:59.000Z' }],
  ['回执之后的事件', { at: '2026-10-18T12:00:03.000Z' }],
  ['没有时间身份', { at: 'invalid' }],
  ['不属于输入的状态记录', { type: 'state' }],
  ['未知记录协议', { schemaVersion: 2 }],
] as const) {
  test(`${name}不能作为原生输入证据`, () => {
    const result = nativeEvidenceOf([{ ...record, ...patch }], receipt)
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.length > 0)
  })
}

for (const [name, value] of [
  ['缺失回执', null],
  ['没有原生动作引用', { ...receipt, actionRef: '' }],
  ['没有受控样本来源', { ...receipt, source: null }],
  ['没有样本名', { ...receipt, source: { ...receipt.source, fixtureIds: [] } }],
  ['没有复制来源证据', { ...receipt, source: { ...receipt.source, proof: '' } }],
  ['协议动作回执', { ...receipt, method: 'playwright' }],
  ['旧版本动作回执', { ...receipt, sdkVersion: '1.0.0' }],
  ['未关联事件', { ...receipt, eventSequences: [] }],
  ['关联不存在的事件', { ...receipt, eventSequences: [3] }],
  ['缺少部分已声明事件', { ...receipt, eventSequences: [2, 3] }],
  ['重复关联事件', { ...receipt, eventSequences: [2, 2] }],
  ['无效时间区间', { ...receipt, startedAt: receipt.finishedAt, finishedAt: receipt.startedAt }],
] as const) {
  test(`${name}不能授予原生证据资格`, () => {
    const result = nativeEvidenceOf([record], value)
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.length > 0)
  })
}

test('同轮混入另一页相同序号不能被错误关联', () => {
  assert.equal(nativeEvidenceOf([{ ...record, pageId: 'other-page' }, record], receipt).eligible, true)
  assert.equal(nativeEvidenceOf([record, record], receipt).eligible, false)
})
