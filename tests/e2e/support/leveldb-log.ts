// Chromium 系的 IndexedDB 存在每个来源一个 LevelDB 里（资料目录的 Default/IndexedDB/<协议>_<主机>_<端口>.indexeddb.leveldb/），这里读它的日志、
// 必要时往日志结尾补一个只有头的记录（M4-P1 设计 §3.8，S9 第 5 项）。S7 的调查：进程被结束在往日志追加一条记录的两次 write 之间（记录头写了、
// 内容没写）时，结尾只剩记录头；下一次打开时这半条被悄悄丢掉、一切正常，但 reuse_logs 让新数据接在它后面写；再下一次打开时校验和不符，
// Chromium 删掉这个来源的全部 IndexedDB。所以：
// - 每次结束之后读日志的结尾：torn-*（写了一半）是前兆，corrupt（只有头的记录后面又接上了字节）是下一次打开必删库，记进崩溃工具的附件；
// - 补一个只有头的记录，确定地造出删库（之后的一次会话写过东西，再下一次打开时删）。
// 日志格式（LevelDB 的 log_format）：32 KiB 一块；记录头 7 字节——掩码过的 CRC32C（4 字节，小端，覆盖类型字节与内容）、内容的长度（2 字节，
// 小端）、类型（1 完整、2 开头、3 中间、4 结尾）；块尾不足 7 字节补零。纯函数在前（单元测试），读写文件的在后
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_BLOCK_SIZE = 32_768
export const LOG_HEADER_SIZE = 7

const FULL = 1
const FIRST = 2
const MIDDLE = 3
const LAST = 4

/** CRC32C（Castagnoli，反射多项式 0x82F63B78）的查表 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1)
      value = (value & 1) === 1 ? (value >>> 1) ^ 0x82F63B78 : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xFF] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

const MASK_DELTA = 0xA282EAD8

/** LevelDB 存进记录头的校验：右转 15 位加一个常数（内容里本身带 CRC 时不至于算出相同的值） */
export function maskCrc(crc: number): number {
  return ((((crc >>> 15) | (crc << 17)) >>> 0) + MASK_DELTA) >>> 0
}

export function unmaskCrc(masked: number): number {
  const rotated = (masked - MASK_DELTA) >>> 0
  return ((rotated >>> 17) | (rotated << 15)) >>> 0
}

/**
 * 日志结尾的状态：
 * - clean：每条记录都完整；
 * - torn-header、torn-payload、torn-fragmented：结尾写了一半（记录头不完整、内容不完整、大记录的分片没写完）——恢复时悄悄丢掉，删库的前兆；
 * - corrupt：中间有读不过去的记录（例如只有头的记录后面又接上了字节）——Chromium 以 paranoid 检查打开，下一次打开失败、删库
 */
export type LogTailStatus = 'clean' | 'torn-header' | 'torn-payload' | 'torn-fragmented' | 'corrupt'

export interface LogTail {
  readonly status: LogTailStatus
  /** 读得过去的逻辑记录数（跨块的分片算一条） */
  readonly records: number
  readonly size: number
  /** 不是 clean 时：哪里、什么样（偏移、类型、声明的长度） */
  readonly detail: string
}

/** 按 LevelDB 读日志的规则读到底，认出结尾的状态（读法同 log::Reader：块尾不足 7 字节的跳过，类型与长度都为 0 的跳过这一块剩下的） */
export function classifyLog(bytes: Uint8Array): LogTail {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let records = 0
  let inFragment = false
  const done = (status: LogTailStatus, detail: string): LogTail => ({ status, records, size: bytes.length, detail })
  while (offset < bytes.length) {
    const blockEnd = Math.min(bytes.length, (Math.floor(offset / LOG_BLOCK_SIZE) + 1) * LOG_BLOCK_SIZE)
    const leftover = blockEnd - offset
    if (leftover < LOG_HEADER_SIZE) {
      if (blockEnd === bytes.length && bytes.length % LOG_BLOCK_SIZE !== 0 && bytes.subarray(offset).some(byte => byte !== 0))
        return done('torn-header', `结尾 ${leftover} 字节的记录头不完整（偏移 ${offset}）`)
      offset = blockEnd
      continue
    }
    const length = view.getUint16(offset + 4, true)
    const type = bytes[offset + 6] ?? 0
    if (type === 0 && length === 0) {
      offset = blockEnd
      continue
    }
    if (LOG_HEADER_SIZE + length > leftover) {
      if (blockEnd === bytes.length)
        return done('torn-payload', `偏移 ${offset} 的记录（类型 ${type}，长度 ${length}）结尾只有 ${leftover - LOG_HEADER_SIZE} 字节内容`)
      return done('corrupt', `偏移 ${offset}：bad record length（类型 ${type}，长度 ${length}，块里剩 ${leftover} 字节）`)
    }
    const end = offset + LOG_HEADER_SIZE + length
    if (unmaskCrc(view.getUint32(offset, true)) !== crc32c(bytes.subarray(offset + 6, end)))
      return done('corrupt', `偏移 ${offset}：checksum mismatch（类型 ${type}，长度 ${length}${end === bytes.length ? '，在结尾' : ''}）`)
    switch (type) {
      case FULL:
      case FIRST:
        if (inFragment)
          return done('corrupt', `偏移 ${offset}：partial record without end（类型 ${type}）`)
        if (type === FULL)
          records += 1
        else
          inFragment = true
        break
      case MIDDLE:
      case LAST:
        if (!inFragment)
          return done('corrupt', `偏移 ${offset}：missing start of fragmented record（类型 ${type}）`)
        if (type === LAST) {
          inFragment = false
          records += 1
        }
        break
      default:
        return done('corrupt', `偏移 ${offset}：未知的类型 ${type}`)
    }
    offset = end
  }
  return inFragment ? done('torn-fragmented', '大记录的分片没有写完（只有开头或中间）') : done('clean', '')
}

/** 往 size 字节长的日志结尾补的字节：块尾放不下头加 1 字节内容时先补零（同 LevelDB 的写法），然后是只有头的完整类型的记录 */
export interface TornRecord {
  readonly bytes: Uint8Array
  /** 补零的字节数 */
  readonly padding: number
  /** 头的偏移 */
  readonly offset: number
  /** 头里声明的内容长度（块里放不下给的长度时收到块尾为止） */
  readonly declaredLength: number
}

/**
 * 模拟"被结束在记录头写了、内容没写之间"：只有头的记录。校验随意（0x44332211），与之后接上的字节对不上。
 * 声明的长度短（默认 64）时，下一次会话写过一点东西就够了，再下一次打开时校验不符、删库；长时（之后写的不够它）恢复时把之后写的悄悄丢掉
 */
export function tornRecordBytes(size: number, declaredLength: number): TornRecord {
  if (!Number.isInteger(declaredLength) || declaredLength < 1 || declaredLength > LOG_BLOCK_SIZE - LOG_HEADER_SIZE)
    throw new Error(`声明的长度要在 1 到 ${LOG_BLOCK_SIZE - LOG_HEADER_SIZE} 之间：${declaredLength}`)
  const leftover = LOG_BLOCK_SIZE - (size % LOG_BLOCK_SIZE)
  const padding = leftover < LOG_HEADER_SIZE + 1 ? leftover : 0
  const room = (padding > 0 ? LOG_BLOCK_SIZE : leftover) - LOG_HEADER_SIZE
  const declared = Math.min(declaredLength, room)
  const bytes = new Uint8Array(padding + LOG_HEADER_SIZE)
  bytes.set([0x11, 0x22, 0x33, 0x44, declared & 0xFF, declared >>> 8, FULL], padding)
  return { bytes, padding, offset: size + padding, declaredLength: declared }
}

/** 一个来源的 IndexedDB 在资料目录里的目录名（Chromium：协议_主机_端口）。只认带端口的来源（E2E 的服务端口都是挑出来的） */
export function indexedDbDirName(origin: string): string {
  const url = new URL(origin)
  if (url.port === '')
    throw new Error(`来源不带端口，认不出 IndexedDB 的目录名：${origin}`)
  return `${url.protocol.slice(0, -1)}_${url.hostname}_${url.port}.indexeddb.leveldb`
}

/** 当前的日志：编号最大的 .log（按数字比） */
export function currentLogName(files: readonly string[]): string | undefined {
  return files
    .filter(name => /^\d+\.log$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .at(-1)
}

// ---- 读写文件 ----

/** 一个来源的 IndexedDB 的日志与结尾的状态 */
export interface IndexedDbLogState {
  /** 目录名（来源） */
  readonly database: string
  readonly log: string
  readonly tail: LogTail
}

function indexedDbRoot(profileDir: string): string {
  return join(profileDir, 'Default', 'IndexedDB')
}

/** 资料目录里各个来源的 IndexedDB 的当前日志与结尾的状态；不是 Chromium 系的资料目录（没有这个目录）时为空 */
export function indexedDbLogStates(profileDir: string): IndexedDbLogState[] {
  const root = indexedDbRoot(profileDir)
  if (!existsSync(root))
    return []
  return readdirSync(root).filter(name => name.endsWith('.indexeddb.leveldb')).sort().flatMap((database) => {
    const log = currentLogName(readdirSync(join(root, database)))
    return log === undefined ? [] : [{ database, log, tail: classifyLog(new Uint8Array(readFileSync(join(root, database, log)))) }]
  })
}

/** 补了只有头的记录：在哪个文件、原来多长，补的是什么，补完之后结尾的状态 */
export interface TornLog {
  readonly database: string
  readonly log: string
  readonly sizeBefore: number
  readonly record: Omit<TornRecord, 'bytes'>
  readonly tail: LogTail
}

/**
 * 往这个来源的 IndexedDB 的当前日志结尾补一个只有头的记录。要在浏览器全部退出之后、重开之前调用（日志没有人在写）；
 * 日志原来的结尾必须完整（已经写了一半时再补就不是"确定地"造出来的了）
 */
export function tearIndexedDbLog(profileDir: string, origin: string, declaredLength: number): TornLog {
  const database = indexedDbDirName(origin)
  const dir = join(indexedDbRoot(profileDir), database)
  if (!existsSync(dir))
    throw new Error(`这个来源没有 LevelDB 的 IndexedDB（${dir}）：还没打开过 IndexedDB，或者浏览器换了后端（例如 Chromium 的 SQLite 后端；那样 UR-034 的前提不在了）`)
  const log = currentLogName(readdirSync(dir))
  if (log === undefined)
    throw new Error(`${dir} 里没有日志`)
  const file = join(dir, log)
  const before = classifyLog(new Uint8Array(readFileSync(file)))
  if (before.status !== 'clean')
    throw new Error(`日志的结尾本来就不完整（${before.status}：${before.detail}），不再补`)
  const sizeBefore = statSync(file).size
  const { bytes, ...record } = tornRecordBytes(sizeBefore, declaredLength)
  appendFileSync(file, bytes)
  return { database, log, sizeBefore, record, tail: classifyLog(new Uint8Array(readFileSync(file))) }
}
