import type { DependencyOverride } from '@univerjs/core'
import { ILocalStorageService } from '@univerjs/core'

/** SDK 偏好只属于当前注入器；销毁后迟到的 UI 回调不能重新留下内容。 */
export class MemoryLocalStorageService implements ILocalStorageService {
  private readonly values = new Map<string, unknown>()
  private disposed = false

  async getItem<T>(key: string): Promise<T | null> {
    const value = this.values.get(key) as T | undefined
    return value === undefined ? null : structuredClone(value)
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    if (!this.disposed)
      this.values.set(key, structuredClone(value))
    return value
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key)
  }

  async clear(): Promise<void> {
    this.values.clear()
  }

  async key(index: number): Promise<string | null> {
    return [...this.values.keys()][index] ?? null
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }

  async iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
    let index = 1
    for (const [key, value] of this.values) {
      const result = iteratee(structuredClone(value) as T, key, index++)
      if (result !== undefined)
        return result
    }
    // 1.0.1 的接口声明 U，但两个浏览器驱动遍历结束均返回 undefined。
    return undefined as U
  }

  dispose(): void {
    this.disposed = true
    this.values.clear()
  }
}

/** 交给 UniverUIPlugin 的配置；核心 Univer override 不注册此服务，放在那里不会生效。 */
export function memoryLocalStorageOverride(): DependencyOverride {
  return [[ILocalStorageService, { useClass: MemoryLocalStorageService }]]
}
