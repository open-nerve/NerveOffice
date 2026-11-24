// 记下 Worker 里开的每一个 IndexedDB 事务（测试构建里记事务的发件箱 Worker 用，outbox-probe.worker.ts）：仓库、模式与要求的持久性，
// 经以 Worker 的名字为名的 BroadcastChannel 发给页面里的探针（pipeline-probe.ts）。不经 Worker 自己的消息：那是协议的通道，
// 客户端认不出的消息会让它把 Worker 当作坏了。只在测试构建里
import type { ProbeWorkerTransaction } from './pipeline-probe.ts'

/** Worker 的名字（new Worker 的 name）：DOM 的类型里全局的 name 是 void（防误用），Worker 里它是创建时给的名字 */
const workerName = (globalThis as unknown as { readonly name: string }).name
const channel = new BroadcastChannel(workerName)
const original: unknown = Reflect.get(IDBDatabase.prototype, 'transaction')
if (typeof original !== 'function')
  throw new TypeError('IDBDatabase.prototype.transaction 不是函数')

Object.defineProperty(IDBDatabase.prototype, 'transaction', {
  configurable: true,
  writable: true,
  value: function transaction(this: IDBDatabase, stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction {
    const record: ProbeWorkerTransaction = { stores: typeof stores === 'string' ? [stores] : [...stores], mode: mode ?? 'readonly', durability: options?.durability }
    channel.postMessage(record)
    return Reflect.apply(original, this, [stores, mode, options]) as IDBTransaction
  },
})
