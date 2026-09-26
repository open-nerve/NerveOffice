// 主入口不引用任何第三方包；第三方包只出现在 Worker 里
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
worker.postMessage('ping')
