// 切换耗时的汇总（M3-P2 S5）：读 measure/test-results/switch/ 下每个浏览器、每份文档的结果（switch.spec.ts 写出），
// 按浏览器、文档、方向分组，打印 p50 / p95 / 最大值（毫秒）的 Markdown 表，同时写进那个目录的 summary.md。
// measure:switch 跑完实测之后接着执行；单独执行：NODE_OPTIONS=--conditions=@nerve-office/source node measure/summarize.ts
import type { SwitchDurationKey } from '../../../apps/web/src/editor/testing/switch-timing.ts'
import type { SwitchGroup, SwitchRun } from '../support/measure-stats.ts'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { switchGroups, switchTable } from '../support/measure-stats.ts'

const RESULTS_DIR = join(import.meta.dirname, 'test-results', 'switch')

const BROWSER_ORDER = ['chromium', 'chrome', 'webkit']
const DOCUMENT_ORDER = ['small', 'medium', 'large']
const DIRECTION_ORDER = ['open', 'enter', 'exit', 'refresh']

const NAMES: Readonly<Partial<Record<SwitchDurationKey, string>>> = {
  feedback: '页头说明"正在…"',
  header: '页头到目标状态',
  ready: '可以操作（ready）',
  steady: '到 steady',
  network: '网络',
  acquire: '申请编辑权',
  content: '读内容',
  save: '保存',
  release: '释放',
  beforeRebuild: '点击到开始新建',
  dispose: '销毁旧的（含取视图）',
  rebuild: '重建到 ready',
  rebuildSteady: '重建到 steady',
  syncCreate: '同步创建',
  firstRender: '到 Rendered',
  readyWait: 'Rendered 到 ready',
}

function order(list: readonly string[], value: string): number {
  const index = list.indexOf(value)
  return index < 0 ? list.length : index
}

function main(): void {
  const files = readdirSync(RESULTS_DIR).filter(name => name.endsWith('.json')).sort()
  if (files.length === 0)
    throw new Error(`${RESULTS_DIR} 下没有结果：先跑 measure:switch`)
  const runs = files.map(name => JSON.parse(readFileSync(join(RESULTS_DIR, name), 'utf8')) as SwitchRun)
  const groups: SwitchGroup[] = runs.flatMap(switchGroups).sort((a, b) =>
    order(BROWSER_ORDER, a.browser) - order(BROWSER_ORDER, b.browser)
    || order(DOCUMENT_ORDER, a.document) - order(DOCUMENT_ORDER, b.document)
    || order(DIRECTION_ORDER, a.direction) - order(DIRECTION_ORDER, b.direction))
  const environment = runs
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map(run => `| ${run.browser.project} ${run.browser.version} | ${run.document.id}（${run.document.title}，${run.document.bytes} 字节）：${run.document.scale} | ${run.startedAt} | ${run.load.before.map(value => value.toFixed(2)).join(' ')} → ${run.load.after.map(value => value.toFixed(2)).join(' ')} |`)
  const text = [
    '## 环境',
    '',
    '| 浏览器 | 文档 | 开始 | 负载（1、5、15 分钟：开始 → 结束） |',
    '| --- | --- | --- | --- |',
    ...environment,
    '',
    '## 总耗时（p50 / p95 / 最大值，毫秒；起点是页面收到点击，打开是导航开始）',
    '',
    switchTable(groups, ['feedback', 'header', 'ready', 'steady'], NAMES),
    '',
    '## 各段（p50 / p95 / 最大值，毫秒）',
    '',
    switchTable(groups, ['network', 'acquire', 'content', 'release', 'beforeRebuild', 'dispose', 'rebuild', 'rebuildSteady'], NAMES),
    '',
    '## 重建的细分（p50 / p95 / 最大值，毫秒）',
    '',
    switchTable(groups, ['syncCreate', 'firstRender', 'readyWait'], NAMES),
    '',
  ].join('\n')
  writeFileSync(join(RESULTS_DIR, 'summary.md'), text)
  process.stdout.write(text)
}

main()
