import type { IImageIoServiceParam, Nullable } from '@univerjs/core'
import type { ProbeRecord } from './record.ts'
import { IImageIoService, ImageSourceType, ImageUploadStatusType, LocaleType, LogLevel, Univer } from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverDocsDrawingPlugin } from '@univerjs/docs-drawing'
import { UniverDocsUIPlugin } from '@univerjs/docs-ui'
import { UniverDrawingPlugin } from '@univerjs/drawing'
import { UniverDrawingUIPlugin } from '@univerjs/drawing-ui'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import { UniverSheetsDrawingPlugin } from '@univerjs/sheets-drawing'
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import { UniverSheetsFormulaUIPlugin } from '@univerjs/sheets-formula-ui'
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt'
import { UniverSheetsNumfmtUIPlugin } from '@univerjs/sheets-numfmt-ui'
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui'
import { defaultTheme } from '@univerjs/themes'
import { UniverUIPlugin } from '@univerjs/ui'
import { Subject } from 'rxjs'
import { SHEET_ZH_CN } from '../../../apps/web/src/editor/profile/locale.ts'
import '../../../apps/web/src/editor/profile/styles.ts'
import '@univerjs/ui/facade'
import '@univerjs/docs-ui/facade'
import '@univerjs/sheets/facade'
import '@univerjs/sheets-ui/facade'
import '@univerjs/sheets-formula/facade'
import '@univerjs/sheets-drawing/facade'
import '@univerjs/sheets-drawing-ui/facade'
import './probe.css'

declare const __M5_PROBE_BUILD__: { buildId: string, sdkVersion: string, dependencies: Record<string, unknown> }
const query = new URLSearchParams(location.search)
const mode = query.get('mode') === 'diagnostic' ? 'diagnostic' : 'default'
const method = ['native-ui', 'protocol'].includes(query.get('method') ?? '') ? query.get('method') as 'native-ui' | 'protocol' : 'synthetic'
const runId = query.get('run') ?? 'unassigned'
const copyStrategy = query.get('copyStrategy') === 'gesture' ? 'gesture' : 'delayed'
const pageId = crypto.randomUUID()
const identity = { buildId: __M5_PROBE_BUILD__.buildId, sdkVersion: __M5_PROBE_BUILD__.sdkVersion, runId, pageId, userAgent: navigator.userAgent, mode, method }
const caseInput = document.querySelector<HTMLInputElement>('#case')!
caseInput.value = query.get('case') ?? 'unassigned'
const sheetElement = document.querySelector<HTMLElement>('#sheet')!
const blockDrop = document.querySelector<HTMLInputElement>('#block-drop')!
const compensate = document.querySelector<HTMLInputElement>('#compensate')!
blockDrop.checked = mode === 'diagnostic' && query.get('drop') === '1'
compensate.checked = mode === 'diagnostic' && query.get('copy') === '1'
if (copyStrategy === 'gesture') document.querySelector('#copy-label')!.textContent = '诊断：按键同步复制首图'
blockDrop.disabled = compensate.disabled = mode !== 'diagnostic'
document.querySelector<HTMLButtonElement>('#copy-selected')!.disabled = mode !== 'diagnostic'
document.body.dataset.role = query.get('role') ?? 'sheet'
document.querySelector('#identity')!.textContent = `${mode} / ${method} / SDK ${identity.sdkVersion} / ${identity.buildId.slice(0, 12)} / ${runId}`
let armed = method !== 'native-ui'
let sequence = 0
const records: ProbeRecord[] = []
let api: FUniver | undefined
const sheet = () => api?.getActiveWorkbook()?.getActiveSheet()
const imageCount = () => sheet()?.getImages().length ?? 0
const status = document.querySelector<HTMLOutputElement>('#status')!

function record(type: string, fields: Partial<ProbeRecord> = {}): ProbeRecord {
  const value: ProbeRecord = { ...identity, schemaVersion: 1, caseId: caseInput.value, seq: ++sequence, at: new Date().toISOString(), type,
    target: 'page', isTrusted: null, defaultPrevented: false, types: [], files: [], drawingCount: imageCount(), error: null, ...fields }
  records.push(value)
  document.querySelector('#events')!.textContent = records.slice(-3).map(item => `${item.seq} ${item.type} ${item.target} trusted=${item.isTrusted} drawing=${item.drawingCount} ${item.error ?? JSON.stringify(item.types)}`).join('\n')
  // 捕获阶段先发最小记录，默认 drop 导航发生前就有原件；文件摘要随后追加而非覆盖。
  const sent = navigator.sendBeacon('/records', new Blob([JSON.stringify(value)], { type: 'application/json' }))
  if (!sent) status.textContent = '记录传送队列拒绝：本轮证据不完整'
  return value
}

async function digest(file: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')
}

function captureState(reason: string) {
  const current = sheet()
  const images = current?.getImages().map(item => ({ id: item.getId(), source: item.toBuilder().getSource().slice(0, 200), sourceType: item.toBuilder().getSourceType() })) ?? []
  return record('state', { details: { reason, images, cells: current?.getRange('A1:D5').getValues(), href: location.href, visible: document.visibilityState } })
}

class DiagnosticImageIo implements IImageIoService {
  private waiting = 0
  private changes = new Subject<number>()
  private cache = new Map<string, HTMLImageElement>()
  change$ = this.changes.asObservable()
  setWaitCount(count: number) { this.waiting = count; this.changes.next(count) }
  getImageSourceCache(source: string) { return this.cache.get(source) }
  addImageSourceCache(source: string, _type: ImageSourceType, image: Nullable<HTMLImageElement>) {
    if (image) this.cache.set(source, image)
    else this.cache.delete(source)
  }
  async getImage(imageId: string) { return `${location.origin}/probe-images/${imageId}` }
  async saveImage(file: File): Promise<IImageIoServiceParam> {
    try {
      const response = await fetch('/probe-images', { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
      if (!response.ok) throw new Error(`诊断上传 HTTP ${response.status}`)
      const uploaded = await response.json() as { imageId: string, source: string }
      record('diagnostic-upload', { files: [{ type: file.type, size: file.size, sha256: await digest(file) }], details: uploaded })
      return { ...uploaded, imageSourceType: ImageSourceType.URL, base64Cache: uploaded.source, status: ImageUploadStatusType.SUCCUSS }
    }
    finally { this.setWaitCount(Math.max(0, this.waiting - 1)) }
  }
}
const diagnosticIo = new DiagnosticImageIo()

async function insertDiagnostic(file: File) {
  const saved = await diagnosticIo.saveImage(file)
  const inserted = await sheet()?.insertImage(saved.source, 1, 2)
  record('diagnostic-insert', { details: { inserted } })
  return inserted
}

async function insertFixture(name: string) {
  const response = await fetch(`/fixtures/${name}`)
  if (!response.ok) throw new Error(`样本读取 ${response.status}`)
  const blob = await response.blob()
  if (mode === 'diagnostic') return insertDiagnostic(new File([blob], name, { type: blob.type }))
  const reader = new FileReader()
  const source = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
  })
  const current = sheet()
  if (!current) throw new Error('表格尚未就绪')
  const image = await current.newOverGridImage().setSource(source, ImageSourceType.BASE64).setColumn(1).setRow(2).buildAsync()
  current.insertImages([image])
  return current.getImages().some(item => item.getId() === image.drawingId)
}

async function firstImageAsPng(): Promise<Blob> {
  const source = sheet()?.getImages()[0]?.toBuilder().getSource()
  if (!source) throw new Error('没有表格图片')
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = source
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 编码失败')), 'image/png'))
}

function copyDiagnostic(origin: string) {
  // ClipboardItem 的 promise 保留 Safari 用户激活语义；是否获准由真实场景决定。
  const started = performance.now()
  const pending = navigator.clipboard.write([new ClipboardItem({ 'image/png': firstImageAsPng() })])
  void pending.then(() => record('diagnostic-copy', { details: { origin, elapsedMs: performance.now() - started, resolved: true } }))
    .catch(error => record('diagnostic-copy', { error: String(error), details: { origin, elapsedMs: performance.now() - started } }))
  return pending
}

let copyTimer: number | undefined
function scheduleDiagnosticCopy(origin: string) {
  // 原生 SDK 快捷键会直接调用 Clipboard API；DOM copy 并非必经路径。
  if (copyTimer !== undefined) window.clearTimeout(copyTimer)
  record('diagnostic-copy-scheduled', { details: { origin, delayMs: 350 } })
  copyTimer = window.setTimeout(() => {
    copyTimer = undefined
    void copyDiagnostic(`after-sdk-${origin}-350ms`).catch(() => {})
  }, 350)
}
window.addEventListener('keydown', event => {
  if (armed && compensate.checked && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && !event.repeat && event.key.toLowerCase() === 'c' && event.target instanceof Element && event.target.closest('#sheet')) {
    if (copyStrategy === 'gesture') {
      // 仅实验：本用例明确选择唯一受控图片。正式接线还必须区分图片/单元格焦点。
      event.preventDefault()
      event.stopImmediatePropagation()
      record('diagnostic-copy-intercepted', { target: 'sheet', isTrusted: event.isTrusted, defaultPrevented: true, details: { origin: 'keyboard-gesture' } })
      void copyDiagnostic('keyboard-gesture').catch(() => {})
    }
    else scheduleDiagnosticCopy('keyboard')
  }
}, true)

for (const type of ['paste', 'copy', 'drop'] as const) {
  window.addEventListener(type, (event: Event) => {
    if (!armed) return
    const transfer = event instanceof ClipboardEvent ? event.clipboardData : event instanceof DragEvent ? event.dataTransfer : null
    const target = event.target instanceof Element ? event.target.closest('#sheet, #receiver, #fixtures, #html-source')?.id ?? event.target.tagName : 'unknown'
    const files = Array.from(transfer?.files ?? [])
    if (type === 'drop' && target === 'sheet' && blockDrop.checked) event.preventDefault()
    const captured = record(type, { target, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
      types: Array.from(transfer?.types ?? []), files: files.map(file => ({ type: file.type, size: file.size, sha256: null })),
      details: { text: transfer?.getData('text/plain').slice(0, 4096), html: transfer?.getData('text/html').slice(0, 16384), blockDrop: blockDrop.checked, compensate: compensate.checked, copyStrategy } })
    void Promise.all(files.map(async file => ({ type: file.type, size: file.size, sha256: await digest(file) })))
      .then(files => { if (files.length) record('file-digests', { target, files, details: { inputSequence: captured.seq } }) })
      .catch(error => record('digest-error', { error: String(error), details: { inputSequence: captured.seq } }))
    queueMicrotask(() => record('event-settled', { target, defaultPrevented: event.defaultPrevented, details: { inputSequence: captured.seq } }))
    setTimeout(() => captureState(`after-${captured.seq}`), 1200)
    if (type === 'drop' && target === 'sheet' && blockDrop.checked) {
      for (const file of files) void insertDiagnostic(file).catch(error => record('diagnostic-drop-error', { error: String(error) }))
    }
    if (type === 'copy' && target === 'sheet' && compensate.checked)
      scheduleDiagnosticCopy('copy-event')
  }, true)
}
sheetElement.addEventListener('dragover', event => { if (blockDrop.checked) event.preventDefault() })
window.addEventListener('error', event => record('error', { error: event.message }))
window.addEventListener('unhandledrejection', event => record('unhandledrejection', { error: String(event.reason) }))
window.addEventListener('pagehide', () => record('pagehide', { details: { href: location.href } }))
document.addEventListener('securitypolicyviolation', event => record('csp-violation', { details: { directive: event.violatedDirective, blockedURI: event.blockedURI } }))
document.querySelector('#arm')!.addEventListener('click', () => { armed = true; record('armed'); status.textContent = '记录已开启；只操作本任务受控样本' })
document.querySelector('#capture')!.addEventListener('click', () => captureState('manual'))
document.querySelector('#copy-selected')!.addEventListener('click', () => { void copyDiagnostic('explicit-button').catch(() => {}) })

for (const name of ['sample.png', 'sample.jpg', 'sample.webp', 'sample.gif']) {
  const box = document.createElement('div'); box.className = 'fixture'
  const image = document.createElement('img'); image.src = `/fixtures/${name}`; image.alt = name
  const button = document.createElement('button'); button.textContent = `插入 ${name}`
  button.addEventListener('click', () => {
    record('fixture-button', { details: { name } })
    void insertFixture(name).then(() => captureState('fixture-inserted')).catch(error => record('fixture-error', { error: String(error) }))
  })
  box.append(image, button); document.querySelector('#fixtures')!.append(box)
}

try {
  if (document.body.dataset.role !== 'receiver') {
    const univer = new Univer({ theme: defaultTheme, locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: SHEET_ZH_CN }, logLevel: LogLevel.WARN })
    univer.registerPlugin(UniverDocsPlugin)
    univer.registerPlugin(UniverRenderEnginePlugin)
    univer.registerPlugin(UniverUIPlugin, { container: sheetElement })
    univer.registerPlugin(UniverDocsUIPlugin)
    univer.registerPlugin(UniverFormulaEnginePlugin, { notExecuteFormula: false, intervalCount: 20 })
    univer.registerPlugin(UniverSheetsPlugin, { notExecuteFormula: false, largeSheetOperation: { largeSheetCellCountThreshold: Number.MAX_SAFE_INTEGER } })
    univer.registerPlugin(UniverSheetsUIPlugin)
    univer.registerPlugin(UniverSheetsNumfmtPlugin)
    univer.registerPlugin(UniverSheetsNumfmtUIPlugin)
    univer.registerPlugin(UniverSheetsFormulaPlugin, { notExecuteFormula: false })
    univer.registerPlugin(UniverSheetsFormulaUIPlugin)
    univer.registerPlugin(UniverDrawingPlugin, mode === 'diagnostic' ? { override: [[IImageIoService, { useValue: diagnosticIo }]] } : undefined)
    univer.registerPlugin(UniverDocsDrawingPlugin)
    univer.registerPlugin(UniverDrawingUIPlugin)
    univer.registerPlugin(UniverSheetsDrawingPlugin)
    univer.registerPlugin(UniverSheetsDrawingUIPlugin)
    api = FUniver.newAPI(univer)
    api.createWorkbook({ id: `m5-${pageId}`, name: 'M5 图片路径', sheetOrder: ['sheet1'], sheets: { sheet1: { id: 'sheet1', name: '样本', rowCount: 100, columnCount: 20, cellData: { 0: { 0: { v: 'M5 受控测试' } } } } } })
  }
  status.textContent = '就绪；原生模式须先准备受控样本并开启记录'
  record('ready', { details: { identity, dependencies: __M5_PROBE_BUILD__.dependencies, role: document.body.dataset.role } })
}
catch (error) { record('boot-error', { error: String(error) }); status.textContent = `启动失败：${String(error)}` }

Object.assign(window, { __m5Probe: { identity, records, state: () => captureState('calibration'),
  // 仅自动校准页开放协议插入；原生证据页通过可见按钮准备受控表格。
  insertFixture: method === 'native-ui' ? undefined : insertFixture,
} })
