// 发件箱 Worker 的入口（M4-P1 设计 §3.1、§3.4.8）：薄——把消息接到 Worker 里的处理上（outbox-worker-handler.ts），配上 IndexedDB 的存储
// （shared/outbox/draft-store.ts）与墙上时钟。主线程以模块 Worker 创建它（同源脚本，CSP 的 worker-src 'self'），见
// outbox-worker-client.ts 的 createOutboxWorker。
// - 一启动就开一个 100 ms 的空定时器（DEF-011）：M0 在 WebKit 上测到 Worker 空闲一阵之后，第一次异步操作要多等约 1 秒，保持一个空定时器
//   这个停顿就没有了。真实 Safari 上有没有效由 S1、S8 复核；无效时 WebKit 改在主线程放置（换宿主，管道不变）。
// - 握手里 keepAlive 为 false 时停掉它：只有测试构建能停（DEF-011 的对照），生产构建里这个分支被去掉，停不掉。
// - OPFS 的镜像（设计 §3.8）：同步访问句柄只在专用 Worker 里有，镜像只在这里做；拿不到句柄时按退避（0.5 秒起、每次翻倍、至多 30 秒）再试。
// 不引用 zod（门禁按全部产物数 zod 的 JIT 探测，Worker 里再打进一份就超限），不依赖 DOM（Worker 里没有）
import { createDraftMirror } from '../../../shared/outbox/draft-mirror.ts'
import { createDraftStore } from '../../../shared/outbox/draft-store.ts'
import { opfsMirrorDirectory } from '../../../shared/outbox/mirror-directory.ts'
import { createOutboxWorkerHandler } from './outbox-worker-handler.ts'

/** 空定时器的间隔（毫秒，DEF-011） */
const KEEP_ALIVE_INTERVAL_MS = 100

/**
 * 库的升级被别的标签页挡住时等多久（毫秒）：到点按"不可用（blocked）"交回。要比客户端每个请求的看门狗时限短，
 * 被挡住时页面得到的是"本机存储用不了"，而不是把 Worker 当作坏了
 */
const UPGRADE_BLOCKED_TIMEOUT_MS = 3_000

/** 镜像拿不到句柄（别的标签页占着、写满、出错）之后多久再试（毫秒） */
const MIRROR_RETRY = { initialMs: 500, maxMs: 30_000 }

const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS)

const handler = createOutboxWorkerHandler({
  store: createDraftStore({ blockedTimeoutMs: UPGRADE_BLOCKED_TIMEOUT_MS }),
  mirror: createDraftMirror({ directory: opfsMirrorDirectory(), clock: { now: () => performance.now() }, retry: MIRROR_RETRY }),
  now: () => Date.now(),
  post: (message, transfer) => globalThis.postMessage(message, { transfer }),
  stopKeepAlive: import.meta.env.MODE === 'e2e' ? () => clearInterval(keepAlive) : undefined,
})

globalThis.addEventListener('message', (event) => {
  void handler.receive(event.data)
})
globalThis.addEventListener('messageerror', () => handler.unreadable())
