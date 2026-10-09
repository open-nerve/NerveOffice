// Chromium 的 IndexedDB（LevelDB）日志（leveldb-log.ts）里不碰文件的纯函数：CRC32C 与掩码、按记录读日志认出结尾写了一半与中间读不过去
// （S7 的调查：被结束在追加一条记录的两次 write 之间，结尾只剩记录头，是之后删库的前兆）、往结尾补一个只有头的记录（确定地造出删库）、
// 来源的目录名与当前的日志。日志都按 LevelDB 的格式现造：32 KiB 一块，记录头 7 字节（掩码过的 CRC32C、长度、类型），块尾不足 7 字节补零
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyLog, crc32c, currentLogName, indexedDbDirName, indexedDbLogStates, LOG_BLOCK_SIZE, LOG_HEADER_SIZE, maskCrc, tearIndexedDbLog, tornRecordBytes, unmaskCrc } from './leveldb-log.ts'

const FULL = 1
const FIRST = 2
const MIDDLE = 3
const LAST = 4

/** 一条物理记录：正确的校验（掩码过的、覆盖类型与内容） */
function record(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(LOG_HEADER_SIZE + payload.length)
  const covered = new Uint8Array(1 + payload.length)
  covered[0] = type
  covered.set(payload, 1)
  new DataView(out.buffer).setUint32(0, maskCrc(crc32c(covered)), true)
  out[4] = payload.length & 0xFF
  out[5] = payload.length >>> 8
  out[6] = type
  out.set(payload, LOG_HEADER_SIZE)
  return out
}

function payload(length: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + seed) & 0xFF)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 照 LevelDB 的写法把若干条逻辑记录写成日志：跨块的拆成开头、中间、结尾；块尾不足 7 字节补零 */
function logOf(records: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = []
  let blockOffset = 0
  for (const data of records) {
    let left = data
    let begin = true
    do {
      const leftover = LOG_BLOCK_SIZE - blockOffset
      if (leftover < LOG_HEADER_SIZE) {
        parts.push(new Uint8Array(leftover))
        blockOffset = 0
      }
      const avail = LOG_BLOCK_SIZE - blockOffset - LOG_HEADER_SIZE
      const length = Math.min(left.length, avail)
      const end = length === left.length
      const type = begin && end ? FULL : begin ? FIRST : end ? LAST : MIDDLE
      parts.push(record(type, left.subarray(0, length)))
      blockOffset += LOG_HEADER_SIZE + length
      left = left.subarray(length)
      begin = false
    } while (left.length > 0)
  }
  return concat(...parts)
}

describe('CRC32C 与掩码', () => {
  it('已知答案："123456789" 的 CRC32C 是 0xE3069283，空串是 0', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xE3069283)
    expect(crc32c(new Uint8Array())).toBe(0)
  })

  it('掩码照 LevelDB：右转 15 位加 0xa282ead8；去掉掩码还原', () => {
    expect(maskCrc(0)).toBe(0xA282EAD8)
    expect(maskCrc(0xE3069283)).toBe((((0xE3069283 >>> 15) | (0xE3069283 << 17)) + 0xA282EAD8) >>> 0)
    for (const crc of [0, 1, 0xE3069283, 0xFFFFFFFF, 0x80000000])
      expect(unmaskCrc(maskCrc(crc))).toBe(crc)
  })
})

describe('认出日志的结尾', () => {
  it('完整的日志：clean，按逻辑记录计数（跨块的分片算一条），块尾补的零跳过', () => {
    const log = logOf([payload(100), payload(40_000, 2), payload(10, 3)])
    expect(classifyLog(log)).toEqual({ status: 'clean', records: 3, size: log.length, detail: '' })
    // 恰好留下不足 7 字节的块尾：补零之后接着写
    const nearEnd = logOf([payload(LOG_BLOCK_SIZE - LOG_HEADER_SIZE - 3), payload(5)])
    expect(classifyLog(nearEnd)).toMatchObject({ status: 'clean', records: 2 })
    expect(classifyLog(new Uint8Array())).toMatchObject({ status: 'clean', records: 0, size: 0 })
  })

  it('预分配的零（类型与长度都为 0）：跳过这一块剩下的，下一块照常读；在结尾时算完整', () => {
    const first = logOf([payload(100)])
    const zeros = new Uint8Array(LOG_BLOCK_SIZE - first.length)
    expect(classifyLog(concat(first, zeros, logOf([payload(10, 4)])))).toMatchObject({ status: 'clean', records: 2 })
    expect(classifyLog(concat(first, new Uint8Array(200)))).toMatchObject({ status: 'clean', records: 1 })
  })

  it('结尾只剩记录头（内容 0 字节或只写了一部分）：torn-payload，说明偏移、类型与声明的长度', () => {
    const base = logOf([payload(100)])
    const header = record(FULL, payload(129)).subarray(0, LOG_HEADER_SIZE)
    expect(classifyLog(concat(base, header))).toEqual({ status: 'torn-payload', records: 1, size: base.length + 7, detail: `偏移 ${base.length} 的记录（类型 1，长度 129）结尾只有 0 字节内容` })
    const partial = record(FULL, payload(129)).subarray(0, LOG_HEADER_SIZE + 50)
    expect(classifyLog(concat(base, partial))).toMatchObject({ status: 'torn-payload', detail: `偏移 ${base.length} 的记录（类型 1，长度 129）结尾只有 50 字节内容` })
  })

  it('结尾的记录头本身不完整（1–6 字节）：torn-header', () => {
    const base = logOf([payload(100)])
    for (const length of [1, 6])
      expect(classifyLog(concat(base, new Uint8Array([9, 9, 9, 9, 9, 9]).subarray(0, length)))).toMatchObject({ status: 'torn-header', records: 1 })
  })

  it('大记录的开头分片写完、结尾没写：torn-fragmented', () => {
    const whole = logOf([payload(100), payload(40_000, 2)])
    // 去掉结尾那一片（第二块里的那条记录）
    const cut = whole.subarray(0, LOG_BLOCK_SIZE)
    expect(classifyLog(cut)).toMatchObject({ status: 'torn-fragmented', records: 1 })
  })

  it('只有头的记录后面又接上了新写的字节：corrupt（checksum mismatch），下一次打开时 paranoid 检查失败、删库', () => {
    const base = logOf([payload(100)])
    const header = new Uint8Array([0x11, 0x22, 0x33, 0x44, 64, 0, FULL])
    const appended = concat(base, header, logOf([payload(200, 5)]))
    expect(classifyLog(appended)).toEqual({ status: 'corrupt', records: 1, size: appended.length, detail: `偏移 ${base.length}：checksum mismatch（类型 1，长度 64）` })
  })

  it('其它读不过去的：中间的长度超出块（bad record length）、分片的先后不对、未知的类型', () => {
    const base = logOf([payload(100)])
    // 声明的长度超出这一块、后面还有块：bad record length
    const long = concat(base, new Uint8Array([1, 2, 3, 4, 0xFF, 0xFF, FULL]), new Uint8Array(LOG_BLOCK_SIZE))
    expect(classifyLog(long)).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('bad record length') as unknown })
    // 开头分片之后又来一条完整的：partial record without end
    expect(classifyLog(concat(base, record(FIRST, payload(10)), record(FULL, payload(10))))).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('partial record without end') as unknown })
    // 没有开头的结尾分片：missing start
    expect(classifyLog(concat(base, record(LAST, payload(10))))).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('missing start') as unknown })
    expect(classifyLog(concat(base, record(9, payload(10))))).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('未知的类型 9') as unknown })
  })

  it('内容在结尾、长度够、但校验不对：也是 corrupt（不是写了一半）', () => {
    const base = logOf([payload(100)])
    const bad = record(FULL, payload(20))
    bad[LOG_HEADER_SIZE] = (bad[LOG_HEADER_SIZE] ?? 0) ^ 0xFF
    expect(classifyLog(concat(base, bad))).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('在结尾') as unknown })
  })
})

describe('往结尾补一个只有头的记录', () => {
  it('块里放得下：只追加 7 字节的头，声明的长度照给的；补上之后认出来是 torn-payload，再接上字节就是 corrupt', () => {
    const base = logOf([payload(100)])
    const torn = tornRecordBytes(base.length, 64)
    expect(torn).toMatchObject({ padding: 0, offset: base.length, declaredLength: 64 })
    expect(torn.bytes).toHaveLength(LOG_HEADER_SIZE)
    expect([...torn.bytes.subarray(4)]).toEqual([64, 0, FULL])
    const injected = concat(base, torn.bytes)
    expect(classifyLog(injected)).toMatchObject({ status: 'torn-payload', detail: expect.stringContaining('长度 64）结尾只有 0 字节内容') as unknown })
    expect(classifyLog(concat(injected, logOf([payload(200, 7)])))).toMatchObject({ status: 'corrupt', detail: expect.stringContaining('checksum mismatch') as unknown })
  })

  it('块里剩下的不够头加声明的长度：声明的长度收到块尾为止', () => {
    const size = LOG_BLOCK_SIZE * 2 - 40
    expect(tornRecordBytes(size, 64)).toMatchObject({ padding: 0, offset: size, declaredLength: 40 - LOG_HEADER_SIZE })
  })

  it('块里剩下的连头加 1 字节都放不下：先补零到块尾，头写在下一块的开头', () => {
    const size = LOG_BLOCK_SIZE - 5
    const torn = tornRecordBytes(size, 64)
    expect(torn).toMatchObject({ padding: 5, offset: LOG_BLOCK_SIZE, declaredLength: 64 })
    expect([...torn.bytes.subarray(0, 5)]).toEqual([0, 0, 0, 0, 0])
    expect(torn.bytes).toHaveLength(5 + LOG_HEADER_SIZE)
    expect(tornRecordBytes(LOG_BLOCK_SIZE - LOG_HEADER_SIZE, 64)).toMatchObject({ padding: LOG_HEADER_SIZE, offset: LOG_BLOCK_SIZE })
    // 恰好在块的边界上：不补
    expect(tornRecordBytes(LOG_BLOCK_SIZE, 64)).toMatchObject({ padding: 0, offset: LOG_BLOCK_SIZE })
  })

  it('声明的长度至少 1、至多一块里能放的', () => {
    expect(() => tornRecordBytes(0, 0)).toThrow(/声明的长度/)
    expect(() => tornRecordBytes(0, LOG_BLOCK_SIZE)).toThrow(/声明的长度/)
  })
})

describe('资料目录里的日志（临时目录里现造）', () => {
  const made: string[] = []
  afterEach(() => {
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true })
  })

  /** 一个资料目录：给的来源各有一个 LevelDB 目录，里面是给的文件 */
  function profileWith(databases: Record<string, Record<string, Uint8Array>>): string {
    const profile = mkdtempSync(join(tmpdir(), 'leveldb-log-'))
    made.push(profile)
    for (const [database, files] of Object.entries(databases)) {
      const dir = join(profile, 'Default', 'IndexedDB', database)
      mkdirSync(dir, { recursive: true })
      for (const [name, bytes] of Object.entries(files))
        writeFileSync(join(dir, name), bytes)
    }
    return profile
  }

  it('没有 IndexedDB 目录（WebKit 的资料目录）时为空；每个来源读编号最大的日志', () => {
    expect(indexedDbLogStates(profileWith({}))).toEqual([])
    const old = logOf([payload(10)])
    const current = concat(logOf([payload(20)]), new Uint8Array([1, 2]))
    const profile = profileWith({ 'http_127.0.0.1_4000.indexeddb.leveldb': { '000003.log': old, '000012.log': current, 'MANIFEST-000001': new Uint8Array(3) } })
    expect(indexedDbLogStates(profile)).toEqual([{ database: 'http_127.0.0.1_4000.indexeddb.leveldb', log: '000012.log', tail: classifyLog(current) }])
    expect(indexedDbLogStates(profile)[0]?.tail.status).toBe('torn-header')
  })

  it('补只有头的记录：追加到这个来源的当前日志，交回原来的长度与补完之后的状态；结尾本来就不完整、来源不在时报错、不动文件', () => {
    const log = logOf([payload(100)])
    const profile = profileWith({ 'http_127.0.0.1_4000.indexeddb.leveldb': { '000003.log': log }, 'http_127.0.0.1_5000.indexeddb.leveldb': { '000003.log': log } })
    const torn = tearIndexedDbLog(profile, 'http://127.0.0.1:4000', 64)
    expect(torn).toMatchObject({ database: 'http_127.0.0.1_4000.indexeddb.leveldb', log: '000003.log', sizeBefore: log.length, record: { padding: 0, offset: log.length, declaredLength: 64 } })
    expect(torn.tail.status).toBe('torn-payload')
    const file = join(profile, 'Default', 'IndexedDB', 'http_127.0.0.1_4000.indexeddb.leveldb', '000003.log')
    expect(readFileSync(file)).toHaveLength(log.length + LOG_HEADER_SIZE)
    // 别的来源不动
    expect(readFileSync(join(profile, 'Default', 'IndexedDB', 'http_127.0.0.1_5000.indexeddb.leveldb', '000003.log'))).toHaveLength(log.length)
    expect(() => tearIndexedDbLog(profile, 'http://127.0.0.1:4000', 64)).toThrow(/本来就不完整/)
    expect(readFileSync(file)).toHaveLength(log.length + LOG_HEADER_SIZE)
    expect(() => tearIndexedDbLog(profile, 'http://127.0.0.1:6000', 64)).toThrow(/没有 LevelDB 的 IndexedDB.*UR-034 的前提不在了/)
  })
})

describe('来源的目录与当前的日志', () => {
  it('来源的目录名：协议_主机_端口.indexeddb.leveldb；不带端口的来源报错（E2E 的端口都是挑出来的）', () => {
    expect(indexedDbDirName('http://127.0.0.1:59603')).toBe('http_127.0.0.1_59603.indexeddb.leveldb')
    expect(indexedDbDirName('https://localhost:8443/documents/x')).toBe('https_localhost_8443.indexeddb.leveldb')
    expect(() => indexedDbDirName('http://127.0.0.1')).toThrow(/端口/)
  })

  it('当前的日志是编号最大的 .log（按数字比，不按字面）', () => {
    expect(currentLogName(['000003.log', 'MANIFEST-000001', 'CURRENT', 'LOG', 'LOG.old', '000012.log', '000009.ldb'])).toBe('000012.log')
    expect(currentLogName(['999999.log', '1000000.log'])).toBe('1000000.log')
    expect(currentLogName(['LOG', 'CURRENT'])).toBeUndefined()
  })
})
