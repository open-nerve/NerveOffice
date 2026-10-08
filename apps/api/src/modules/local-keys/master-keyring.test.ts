import type * as Crypto from 'node:crypto'
import type { LocalKeyOwner, WrappedLocalKey } from './master-keyring.ts'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Secret } from '../../shared/secret.ts'
import { createRootLogger } from '../logging/index.ts'
import { generateLocalKey, LocalKeyUnwrapError, MASTER_KEY_ID_BYTES, MasterKeyring, WRAPPED_KEY_BYTES } from './master-keyring.ts'

// 两边是否都传了 authTagLength: 16 只能从调用里看出来：标签按固定位置切成 16 字节，截短的标签走不到 setAuthTag，
// 类型检查也拦不住（这个选项是可选的）。所以包住 node:crypto 的两个函数，照常调用真实的实现、记下参数
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, createCipheriv: vi.fn(actual.createCipheriv), createDecipheriv: vi.fn(actual.createDecipheriv) }
})

afterEach(() => {
  vi.clearAllMocks()
})

const USER = '0199b0c4-7d3e-7a3b-9c4e-2f1a5b6c7d8e'
const OTHER_USER = '0199b0c4-7d3e-7a3b-9c4e-2f1a5b6c7d8f'
const OWNER: LocalKeyOwner = { userId: USER, version: 1 }

function masterKey(bytes: Buffer = randomBytes(32)): Secret {
  return new Secret(bytes.toString('base64'))
}

function flipped(buffer: Buffer, index: number): Buffer {
  const copy = Buffer.from(buffer)
  copy[index] = (copy[index] ?? 0) ^ 0x01
  return copy
}

function unwrapFailure(action: () => unknown): LocalKeyUnwrapError {
  try {
    action()
  }
  catch (error) {
    if (error instanceof LocalKeyUnwrapError)
      return error
    throw error
  }
  throw new Error('没有抛出 LocalKeyUnwrapError')
}

describe('已知答案（KAT）：格式一旦有库里的数据就不能改', () => {
  // 测试向量（不是任何环境的密钥）：主密钥 0x00…0x1f、IV 0xa0…0xab、原始密钥 0x40…0x5f，第 1 版。
  // 期望值另经独立的实现核对过：标识与包装键用 OpenSSL 3.6 的 `openssl kdf … HKDF`，包装结果用 WebCrypto 的 AES-GCM（tagLength 128）
  const MASTER = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
  const IV = Buffer.from(Array.from({ length: 12 }, (_, index) => 0xA0 + index))
  const RAW = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x40 + index))
  const MASTER_KEY_ID = '8a7944620739d620ed1704a43a3ba0c1'
  const WRAPPED = 'a0a1a2a3a4a5a6a7a8a9aaab7a6361a5b36384ed49e44202af05a2094f1dd87c153c86bb3665c8740012a3308c8b059c8aa954523cb72f8e74bbf1fb'

  it('主密钥的标识与 60 字节的包装结果逐字节相同；解开得到原来的密钥', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey(MASTER), { randomIv: () => Buffer.from(IV) })
    expect(keyring.currentMasterKeyId).toBe(MASTER_KEY_ID)
    const wrapped = keyring.wrap(Buffer.from(RAW), OWNER)
    expect(wrapped.masterKeyId.toString('hex')).toBe(MASTER_KEY_ID)
    expect(wrapped.wrappedKey.toString('hex')).toBe(WRAPPED)
    expect(keyring.unwrap({ masterKeyId: Buffer.from(MASTER_KEY_ID, 'hex'), wrappedKey: Buffer.from(WRAPPED, 'hex') }, OWNER).equals(RAW)).toBe(true)
  })

  it('标识与包装键按用途派生（HKDF-SHA256 的 info 不同）：标识不是主密钥的 SHA-256 前缀，也不是包装键的前缀', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey(MASTER))
    expect(keyring.currentMasterKeyId).not.toBe(createHash('sha256').update(MASTER).digest().subarray(0, 16).toString('hex'))
    const wrapKey = Buffer.from(hkdfSync('sha256', MASTER, Buffer.alloc(0), 'nerve-office/local-keys/wrap/v1', 32))
    expect(keyring.currentMasterKeyId).not.toBe(wrapKey.subarray(0, 16).toString('hex'))
  })
})

describe('包装与解包（AES-256-GCM，AAD 绑定用户、版本与主密钥）', () => {
  it('往返：解开得到原来的密钥；包装结果 60 字节，标识 16 字节且就是当前的主密钥；每次的 IV 不同', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const raw = generateLocalKey()
    expect(raw).toHaveLength(32)
    const first = keyring.wrap(raw, OWNER)
    const second = keyring.wrap(raw, OWNER)
    expect(first.wrappedKey).toHaveLength(WRAPPED_KEY_BYTES)
    expect(WRAPPED_KEY_BYTES).toBe(60)
    expect(first.masterKeyId).toHaveLength(MASTER_KEY_ID_BYTES)
    expect(first.masterKeyId.toString('hex')).toBe(keyring.currentMasterKeyId)
    expect(first.wrappedKey.subarray(0, 12).equals(second.wrappedKey.subarray(0, 12))).toBe(false)
    expect(first.wrappedKey.equals(second.wrappedKey)).toBe(false)
    expect(keyring.unwrap(first, OWNER).equals(raw)).toBe(true)
    expect(keyring.unwrap(second, OWNER).equals(raw)).toBe(true)
  })

  it('同一个主密钥的两个环得到同样的标识、互相解得开（重启前后同一把）；不同的主密钥标识不同、互相解不开（不认识的主密钥）', () => {
    const bytes = randomBytes(32)
    const before = MasterKeyring.fromMasterKey(masterKey(bytes))
    const after = MasterKeyring.fromMasterKey(masterKey(bytes))
    const other = MasterKeyring.fromMasterKey(masterKey())
    expect(after.currentMasterKeyId).toBe(before.currentMasterKeyId)
    expect(other.currentMasterKeyId).not.toBe(before.currentMasterKeyId)
    const raw = generateLocalKey()
    const wrapped = before.wrap(raw, OWNER)
    expect(after.unwrap(wrapped, OWNER).equals(raw)).toBe(true)
    const failure = unwrapFailure(() => other.unwrap(wrapped, OWNER))
    expect(failure).toMatchObject({ reason: 'unknown_master_key', userId: USER, version: 1, masterKeyId: before.currentMasterKeyId, currentMasterKeyId: other.currentMasterKeyId })
  })

  it('AAD 的每一项被改都解不开：换成别人、换版本；行上的主密钥标识被改成环里没有的', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const wrapped = keyring.wrap(generateLocalKey(), { userId: USER, version: 2 })
    expect(unwrapFailure(() => keyring.unwrap(wrapped, { userId: OTHER_USER, version: 2 })).reason).toBe('not_authentic')
    expect(unwrapFailure(() => keyring.unwrap(wrapped, { userId: USER, version: 1 })).reason).toBe('not_authentic')
    expect(unwrapFailure(() => keyring.unwrap(wrapped, { userId: USER, version: 3 })).reason).toBe('not_authentic')
    expect(unwrapFailure(() => keyring.unwrap({ ...wrapped, masterKeyId: flipped(wrapped.masterKeyId, 0) }, { userId: USER, version: 2 })).reason).toBe('unknown_master_key')
  })

  it('IV、密文、标签各翻一位都解不开', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const wrapped = keyring.wrap(generateLocalKey(), OWNER)
    for (const [label, index] of [['IV', 0], ['IV', 11], ['密文', 12], ['密文', 43], ['标签', 44], ['标签', 59]] as const) {
      const tampered: WrappedLocalKey = { ...wrapped, wrappedKey: flipped(wrapped.wrappedKey, index) }
      expect(unwrapFailure(() => keyring.unwrap(tampered, OWNER)).reason, `${label}[${index}]`).toBe('not_authentic')
    }
  })

  it('截短的标签被拒：包装结果短了（标签只剩 12、8、4 字节）或者长了都解不开', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const wrapped = keyring.wrap(generateLocalKey(), OWNER)
    for (const length of [56, 52, 48, 61]) {
      const resized = length < 60 ? wrapped.wrappedKey.subarray(0, length) : Buffer.concat([wrapped.wrappedKey, Buffer.alloc(1)])
      expect(unwrapFailure(() => keyring.unwrap({ ...wrapped, wrappedKey: resized }, OWNER)).reason, String(length)).toBe('not_authentic')
    }
  })

  it('加密与解密两边都显式传 authTagLength: 16（不传时 Node 24 收下截短到 4 字节的真标签，只给弃用警告）', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const wrapped = keyring.wrap(generateLocalKey(), OWNER)
    keyring.unwrap(wrapped, OWNER)
    expect(vi.mocked(createCipheriv).mock.calls).toEqual([['aes-256-gcm', expect.anything(), expect.any(Buffer), { authTagLength: 16 }]])
    expect(vi.mocked(createDecipheriv).mock.calls).toEqual([['aes-256-gcm', expect.anything(), expect.any(Buffer), { authTagLength: 16 }]])
  })

  it('抛出的错误与它的日志里没有任何密钥材料（原始密钥、交进来的包装结果与其中的密文、主密钥、包装键）：三种解不开的情形各一次', () => {
    const masterBytes = randomBytes(32)
    const keyring = MasterKeyring.fromMasterKey(masterKey(masterBytes))
    const raw = generateLocalKey()
    const wrapped = keyring.wrap(raw, OWNER)
    /** 每一种情形交进去的包装结果与得到的错误：不认识的主密钥、长度不对、标签对不上 */
    const cases = [
      { input: wrapped, run: (stored: WrappedLocalKey) => MasterKeyring.fromMasterKey(masterKey()).unwrap(stored, OWNER) },
      { input: { ...wrapped, wrappedKey: wrapped.wrappedKey.subarray(0, 56) }, run: (stored: WrappedLocalKey) => keyring.unwrap(stored, OWNER) },
      { input: { ...wrapped, wrappedKey: flipped(wrapped.wrappedKey, 59) }, run: (stored: WrappedLocalKey) => keyring.unwrap(stored, OWNER) },
    ]
    const wrapKey = Buffer.from(hkdfSync('sha256', masterBytes, Buffer.alloc(0), 'nerve-office/local-keys/wrap/v1', 32))
    const reasons: string[] = []
    for (const { input, run } of cases) {
      const failure = unwrapFailure(() => run(input))
      reasons.push(failure.reason)
      // 经应用的根日志记一遍（异常的序列化与脱敏同请求日志），连同消息与打印出来的样子一起找
      const lines: string[] = []
      createRootLogger({ level: 'info', destination: { write: line => void lines.push(line) } }).error({ err: failure }, '请求失败')
      expect(lines.join('')).toContain(failure.masterKeyId)
      const text = `${failure.message}\n${lines.join('')}\n${inspect(failure)}`
      for (const secret of [raw, input.wrappedKey, input.wrappedKey.subarray(12, 44), masterBytes, wrapKey]) {
        expect(text).not.toContain(secret.toString('hex'))
        expect(text).not.toContain(secret.toString('base64'))
      }
      expect(failure.cause).toBeUndefined()
    }
    expect(reasons).toEqual(['unknown_master_key', 'not_authentic', 'not_authentic'])
  })

  it('主密钥环被打印、被序列化时不带任何密钥材料（包装键是 KeyObject，字段是私有的）', () => {
    const masterBytes = randomBytes(32)
    const keyring = MasterKeyring.fromMasterKey(masterKey(masterBytes))
    const wrapKey = Buffer.from(hkdfSync('sha256', masterBytes, Buffer.alloc(0), 'nerve-office/local-keys/wrap/v1', 32))
    const text = `${inspect(keyring, { depth: 10, showHidden: true })}\n${JSON.stringify(keyring)}`
    for (const secret of [masterBytes, wrapKey]) {
      expect(text).not.toContain(secret.toString('hex'))
      expect(text).not.toContain(secret.toString('base64'))
    }
  })
})

describe('接线错误直接报错，不带进 AAD', () => {
  it('用户 id 不是数据库给出的小写写法、版本不是从 1 起的整数、原始密钥不是 32 字节、IV 不是 12 字节、主密钥不是 32 字节', () => {
    const keyring = MasterKeyring.fromMasterKey(masterKey())
    const raw = generateLocalKey()
    expect(() => keyring.wrap(raw, { userId: USER.toUpperCase(), version: 1 })).toThrow('小写')
    expect(() => keyring.wrap(raw, { userId: 'amy', version: 1 })).toThrow('小写')
    for (const version of [0, -1, 1.5])
      expect(() => keyring.wrap(raw, { userId: USER, version }), String(version)).toThrow('从 1 起的整数')
    expect(() => keyring.wrap(randomBytes(31), OWNER)).toThrow('32 字节')
    expect(() => keyring.unwrap(keyring.wrap(raw, OWNER), { userId: USER.toUpperCase(), version: 1 })).toThrow('小写')
    expect(() => MasterKeyring.fromMasterKey(masterKey(), { randomIv: () => randomBytes(16) }).wrap(raw, OWNER)).toThrow('12 字节')
    expect(() => MasterKeyring.fromMasterKey(masterKey(randomBytes(16)))).toThrow('32 字节')
  })
})
