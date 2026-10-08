// 测试用：jsdom 没有布局，也没有 ResizeObserver。vitest.setup.ts 装上这里的替身 FakeResizeObserver：照真实的样子，开始观察之后
// 送来第一条记录（下一个微任务里，高度是元素当时的高度）；之后由用例调用 resize(元素, 高度) 当作布局变了——元素的
// getBoundingClientRect 随之给出这个高度，观察着它的回调随即收到一条记录。真实浏览器里的位置由 E2E 核对。

/** 每个元素正被哪些替身观察着 */
const watching = new Map<Element, Set<FakeResizeObserver>>()

export class FakeResizeObserver implements ResizeObserver {
  readonly #callback: ResizeObserverCallback
  readonly #targets = new Set<Element>()

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback
  }

  observe(target: Element): void {
    this.#targets.add(target)
    const observers = watching.get(target) ?? new Set()
    observers.add(this)
    watching.set(target, observers)
    queueMicrotask(() => {
      if (this.#targets.has(target))
        this.notify(target)
    })
  }

  unobserve(target: Element): void {
    this.#targets.delete(target)
    watching.get(target)?.delete(this)
  }

  disconnect(): void {
    for (const target of this.#targets)
      watching.get(target)?.delete(this)
    this.#targets.clear()
  }

  /** 送一条记录：元素现在的大小（getBoundingClientRect） */
  notify(target: Element): void {
    const rect = target.getBoundingClientRect()
    const size = [{ blockSize: rect.height, inlineSize: rect.width }]
    const entry = { target, contentRect: rect, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size } as unknown as ResizeObserverEntry
    this.#callback([entry], this)
  }
}

/** 这个元素还有没有替身在观察（卸下之后应当没有） */
export function isObserved(target: Element): boolean {
  return (watching.get(target)?.size ?? 0) > 0
}

/** 当作这个元素的高度变成了 height（布局变了）：它的 getBoundingClientRect 随之给出这个高度，观察着它的回调随即收到记录 */
export function resize(target: Element, height: number): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({ height }) } as DOMRect
  Object.defineProperty(target, 'getBoundingClientRect', { configurable: true, value: () => rect })
  for (const observer of [...(watching.get(target) ?? [])])
    observer.notify(target)
}
