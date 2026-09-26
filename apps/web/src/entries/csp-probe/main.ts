// CSP 阳性对照的页面：页面与 Worker 各跑一遍探针，结果写进 #result，完成后给 body 加上 data-probe="done"。
// 目标地址由查询参数 target 给出（E2E 起的另一个源）。
import type { ProbeResult } from './probe.ts'
import { runProbe } from './probe.ts'

async function runInWorker(target: string): Promise<ProbeResult | { error: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<ProbeResult>) => resolve(event.data))
    worker.addEventListener('error', event => resolve({ error: event.message === '' ? 'Worker 加载失败' : event.message }))
    worker.postMessage(target)
  })
}

async function main(): Promise<void> {
  const target = new URLSearchParams(location.search).get('target') ?? ''
  const [page, worker] = await Promise.all([runProbe(target), runInWorker(target)])
  const output = document.getElementById('result')
  if (output !== null)
    output.textContent = JSON.stringify({ page, worker })
  document.body.dataset.probe = 'done'
}

void main()
