// 恢复动作的比较凭证。原始快照只在创建它的存储实例内，跨 Worker 只传键和 id。
import type { DraftKey } from './draft-record.ts'

export interface DraftObservation {
  readonly key: DraftKey
  readonly id: string
}

export interface ObservedValues {
  readonly draft: unknown
  readonly writer: unknown
  readonly notice: unknown
}

const MAX_DEPTH = 128
const MAX_VALUES = 10_000

/**
 * 比较本库存储的数据形状，包含循环/别名和完整字节。未知的结构化克隆类型不猜相等。
 * 事务中同步执行；超限或异常返回 false，调用方保留记录，不退成无条件操作。
 */
export function sameObservedValue(first: unknown, second: unknown): boolean {
  const forward = new Map<object, object>()
  const backward = new Map<object, object>()
  let remaining = MAX_VALUES

  function same(a: unknown, b: unknown, depth: number): boolean {
    if (depth > MAX_DEPTH || --remaining < 0)
      return false
    if (typeof a !== 'object' || a === null)
      return Object.is(a, b)
    if (typeof b !== 'object' || b === null)
      return false
    const tag = Object.prototype.toString.call(a)
    if (tag !== Object.prototype.toString.call(b))
      return false
    if (tag !== '[object Object]' && tag !== '[object Array]' && tag !== '[object ArrayBuffer]' && !ArrayBuffer.isView(a))
      return false
    if (forward.has(a) || backward.has(b))
      return forward.get(a) === b && backward.get(b) === a
    forward.set(a, b)
    backward.set(b, a)
    if (ArrayBuffer.isView(a)) {
      return ArrayBuffer.isView(b) && a.byteLength === b.byteLength && a.byteOffset === b.byteOffset
        && same(a.buffer, b.buffer, depth + 1)
    }
    if (tag === '[object ArrayBuffer]') {
      const left = new Uint8Array(a as ArrayBuffer)
      const right = new Uint8Array(b as ArrayBuffer)
      return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    }
    if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length))
      return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
      && same(Reflect.get(a, key), Reflect.get(b, key), depth + 1))
  }

  try {
    return same(first, second, 0)
  }
  catch {
    return false
  }
}

export function createDraftObservations() {
  const snapshots = new Map<string, { readonly id: string, readonly values: ObservedValues }>()
  const keyOf = (key: DraftKey) => JSON.stringify([key.userId, key.documentId])
  const valuesOf = (observation: DraftObservation): ObservedValues | undefined => {
    const found = snapshots.get(keyOf(observation.key))
    return found?.id === observation.id ? found.values : undefined
  }

  return {
    remember: (key: DraftKey, values: ObservedValues): DraftObservation => {
      const id = crypto.randomUUID()
      // 不能与 readStoredDraft 交给调用方的字节共享；转移缓冲也不会破坏内部观察。
      snapshots.set(keyOf(key), { id, values: structuredClone(values) })
      return Object.freeze({ key: Object.freeze({ userId: key.userId, documentId: key.documentId }), id })
    },
    matches: (observation: DraftObservation, draft: unknown, writer: unknown): boolean => {
      const values = valuesOf(observation)
      return values !== undefined && sameObservedValue(values.draft, draft) && sameObservedValue(values.writer, writer)
    },
    sameNotice: (observation: DraftObservation, notice: unknown): boolean => {
      const values = valuesOf(observation)
      return values !== undefined && sameObservedValue(values.notice, notice)
    },
    forget: (observation: DraftObservation): void => {
      if (valuesOf(observation) !== undefined)
        snapshots.delete(keyOf(observation.key))
    },
    clear: (): void => snapshots.clear(),
  }
}
