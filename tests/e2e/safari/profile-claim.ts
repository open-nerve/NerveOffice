import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

function syncDirectory(path: string): void {
  const directory = openSync(dirname(path), 'r')
  try {
    fsyncSync(directory)
  }
  finally {
    closeSync(directory)
  }
}

/** 不按旧 PID 已死回收。上次观察不完整或失效落盘失败，持久 claim 都使下一轮默认拒绝。 */
export function claimProfile(ledgerPath: string, runId: string) {
  const path = `${ledgerPath}.active`
  const content = `${JSON.stringify({ kind: 'nerve-safari-exclusive-run', runId, createdAt: Date.now() })}\n`
  const file = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(file, content)
    fsyncSync(file)
  }
  finally {
    closeSync(file)
  }
  syncDirectory(path)
  return {
    path,
    release(conditions: { readonly completed: boolean, readonly continuous: boolean, readonly cleanupSucceeded: boolean }): boolean {
      if (!conditions.completed || !conditions.continuous || !conditions.cleanupSucceeded)
        return false
      if (readFileSync(path, 'utf8') !== content)
        throw new Error('本轮持久占用证明已变化，不能释放')
      unlinkSync(path)
      syncDirectory(path)
      return true
    },
  }
}
