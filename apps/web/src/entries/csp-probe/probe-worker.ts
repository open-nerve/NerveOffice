// CSP 阳性对照的 Worker：Worker 内生效的是它自己脚本响应上的策略（00 号计划书 §11.3），所以单独试一遍。
import { runProbe } from './probe.ts'

const scope = globalThis as unknown as {
  addEventListener: (type: 'message', listener: (event: MessageEvent<string>) => void) => void
  postMessage: (message: unknown) => void
}

scope.addEventListener('message', (event) => {
  void runProbe(event.data).then(result => scope.postMessage(result))
})
