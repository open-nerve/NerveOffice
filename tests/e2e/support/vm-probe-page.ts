/** 自包含，宿主和页面分别计算实际字节摘要；不取随机正文或生产数据。 */
export function vmProbeBytes(runId: string, seq: number): Uint8Array {
  const bytes = new Uint8Array(1024 * 1024)
  let state = (Number.parseInt(runId.slice(0, 8), 16) ^ seq) || 0x6D2B79F5
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 255
  }
  bytes.set(new TextEncoder().encode(`nerve-vm/v1/${runId}/${seq}`))
  return bytes
}

/** 由宿主以外部脚本提供给普通浏览器；除 vmProbeBytes 外无模块闭包依赖。 */
export async function vmProbePage(config: { runId: string, durability: 'strict' | 'default', controlPath: string, failureNames: readonly string[] }): Promise<void> {
  const bootId = crypto.randomUUID()
  const common = { runId: config.runId, bootId }
  const status = document.querySelector('#status')!
  const post = async (value: object): Promise<{ kind: string }> => {
    const response = await fetch(config.controlPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, ...value }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error('控制通道拒绝')
    return response.json() as Promise<{ kind: string }>
  }
  const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  const open = async (reading: boolean): Promise<IDBDatabase | undefined> => new Promise((resolve, reject) => {
    const request = indexedDB.open(`nerve-vm-${config.runId}`)
    let absent = false
    request.onupgradeneeded = () => {
      if (reading) {
        absent = true
        request.transaction?.abort()
      }
      else {
        request.result.createObjectStore('records')
      }
    }
    request.onerror = () => absent ? resolve(undefined) : reject(request.error ?? new Error('打开数据库失败'))
    request.onsuccess = () => resolve(request.result)
  })

  let stage = 'control'
  try {
    const command = await post({ kind: 'boot' })
    if (command.kind === 'write') {
      stage = 'write-open'
      const db = await open(false)
      if (db === undefined)
        throw new Error('缺少写入数据库')
      // 突停前不主动 close/sync；保持普通页面连接，避免关闭触发额外刷新。
      Object.assign(window, { __vmProbeDatabase: db })
      for (let seq = 1; ; seq += 1) {
        const body = vmProbeBytes(config.runId, seq) as Uint8Array<ArrayBuffer>
        stage = 'write-hash'
        const hash = await digest(body)
        stage = 'write-transaction'
        const completed = await new Promise<{ actual: IDBTransactionDurability, completedAt: number }>((resolve, reject) => {
          const tx = config.durability === 'strict'
            ? db.transaction('records', 'readwrite', { durability: 'strict' })
            : db.transaction('records', 'readwrite')
          tx.objectStore('records').put({ runId: config.runId, requested: config.durability, actual: tx.durability, seq, digest: hash, body }, 'latest')
          tx.onabort = () => reject(tx.error ?? new Error('写入事务中止'))
          tx.oncomplete = () => resolve({ actual: tx.durability, completedAt: Date.now() })
        })
        // 完成之后不先读取数据库或重新摘要，立即把预先算好的指纹交给宿主。
        stage = 'control'
        const next = await post({ kind: 'completed', requested: config.durability, ...completed, seq, digest: hash })
        status.textContent = `已报告完成 ${seq}`
        if (next.kind === 'wait')
          return
        if (next.kind !== 'write')
          throw new Error('完成证据被拒绝')
      }
    }
    if (command.kind !== 'read')
      throw new Error('启动身份被拒绝')
    stage = 'read-open'
    const db = await open(true)
    let stored: { runId: string, requested: string, actual: string, seq: number, digest: string, body: Uint8Array<ArrayBuffer> } | undefined
    if (db !== undefined) {
      stage = 'read-transaction'
      stored = await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readonly')
        const value: IDBRequest<unknown> = tx.objectStore('records').get('latest')
        tx.onabort = () => reject(tx.error ?? new Error('读取事务中止'))
        tx.oncomplete = () => resolve(value.result as typeof stored)
      })
      db.close()
    }
    let record: object | null = null
    if (stored?.body instanceof Uint8Array && stored.body.byteLength === 1024 * 1024) {
      const { body, ...metadata } = stored
      stage = 'read-hash'
      record = { ...metadata, bodyDigest: await digest(body) }
    }
    stage = 'control'
    const result = await post({ kind: 'read', record })
    if (result.kind !== 'done')
      throw new Error('回读未通过')
    status.textContent = '读取通过'
  }
  catch (error) {
    const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : 'UnexpectedError'
    const errorName = config.failureNames.includes(name) ? name : 'UnexpectedError'
    status.textContent = `失败：${stage}/${errorName}`
    await post({ kind: 'failed', stage, errorName }).catch(() => {})
  }
}
