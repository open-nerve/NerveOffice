// 主密钥环（M3-P6 设计 §3.3）：从主密钥按用途派生包装键与主密钥的标识，用 AES-256-GCM 包装、解包每人的本机密钥。
// 只在 local-keys 模块内部使用（不从模块的公开入口转出）：别的模块拿不到任何人的原始密钥，也拿不到包装键。
//
// 格式（一旦有库里的数据就不能改，由已知答案测试钉住字节）：
// - 包装键 = HKDF-SHA256(主密钥, salt = 空, info = "nerve-office/local-keys/wrap/v1", 32 字节)；主密钥只作 IKM，不直接当 AES 密钥；
// - 主密钥的标识 = HKDF-SHA256(主密钥, salt = 空, info = "nerve-office/local-keys/master-key-id/v1", 16 字节)：按用途分开派生、不可逆，
//   不是机密（启动日志里记它的十六进制，运维据此核对部署的是哪一把）；
// - 包装结果 = IV（12 字节随机数）‖ 密文（32 字节）‖ 标签（16 字节），共 60 字节，一列存（表上的 CHECK 钉住长度）；
// - AAD = JSON.stringify(["nerve-office/local-key/v1", 用户 id, 版本, 主密钥标识的十六进制]) 的 UTF-8 字节：包装结果绑定用户、版本与
//   主密钥，任何一项被改都解不开（换到别人名下、改版本号都不行）。用户 id 用数据库给出的小写写法（ADR-014），别的写法直接拒绝；
// - 加密与解密两边都显式传 authTagLength: 16：Node 24 不传时，截到前 4 字节的真标签照样通过校验（只给弃用警告，探索 A 实测），
//   伪造只需猜中 32 位。类型检查拦不住（这个选项在 @types/node 里是可选的），由单元测试钉住。
// 持有方式：包装键是 KeyObject（inspect 与 JSON 都是空的，不会因为被打进日志而泄漏）；派生时用到的主密钥字节与包装键的字节用完清零
// （尽力而为：配置里的 base64 文本是字符串，清不掉）。主密钥环只有当前这一把；按行上的标识查环，为以后的轮换留好位置（DEF-065）
import type { KeyObject } from 'node:crypto'
import type { Secret } from '../../shared/secret.ts'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes } from 'node:crypto'
import { LOCAL_KEY_BYTES } from '@nerve-office/contracts'

/** IV、标签与包装结果的字节数 */
const IV_BYTES = 12
const TAG_BYTES = 16
export const WRAPPED_KEY_BYTES = IV_BYTES + LOCAL_KEY_BYTES + TAG_BYTES

/** 主密钥与包装键的字节数（AES-256） */
const MASTER_KEY_BYTES = 32
const WRAP_KEY_BYTES = 32
/** 主密钥标识的字节数 */
export const MASTER_KEY_ID_BYTES = 16

const CIPHER = 'aes-256-gcm'
const WRAP_KEY_INFO = 'nerve-office/local-keys/wrap/v1'
const MASTER_KEY_ID_INFO = 'nerve-office/local-keys/master-key-id/v1'
/** AAD 的格式标签：改了格式就换一个，旧的包装结果解不开（而不是被当成新格式误读） */
const AAD_FORMAT = 'nerve-office/local-key/v1'

/** 数据库给出的 UUID 写法（小写、带连字符）：AAD 按字符串绑定，大小写不同就是另一个人 */
const CANONICAL_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/

/** 一把本机密钥属于谁、第几版：都进 AAD */
export interface LocalKeyOwner {
  readonly userId: string
  readonly version: number
}

/** 库里存的那一份：包装它的主密钥的标识（16 字节）与包装结果（60 字节） */
export interface WrappedLocalKey {
  readonly masterKeyId: Buffer
  readonly wrappedKey: Buffer
}

/** 解不开的原因：不是环里的主密钥包装的（主密钥换了、丢了），或者包装结果对不上（被改动、损坏，或者行上的用户、版本被改过） */
export type UnwrapFailure = 'unknown_master_key' | 'not_authentic'

/**
 * 一把本机密钥解不开（M3-P6 设计 §3.5）：取用回 500（意外错误），这一条随请求日志记成 error。字段只有用户、版本与主密钥的标识
 * （都不是机密），没有任何密钥材料；不自动重新生成——处置是找回原来的主密钥，或者由系统管理员吊销（吊销不需要旧密钥，下一版用现在的主密钥包装）
 */
export class LocalKeyUnwrapError extends Error {
  override readonly name = 'LocalKeyUnwrapError'

  constructor(
    readonly reason: UnwrapFailure,
    readonly userId: string,
    readonly version: number,
    /** 行上记的主密钥标识（十六进制） */
    readonly masterKeyId: string,
    /** 现在配置的主密钥的标识（十六进制） */
    readonly currentMasterKeyId: string,
  ) {
    super(reason === 'unknown_master_key'
      ? `第 ${version} 版的本机密钥由主密钥 ${masterKeyId} 包装，不是现在配置的主密钥（${currentMasterKeyId}），解不开：找回原来的主密钥并配置回去，或者由系统管理员吊销这把密钥（下一版用现在的主密钥包装）`
      : `第 ${version} 版的本机密钥解包失败（包装结果与用户、版本、主密钥的标识对不上，可能被改动或损坏）：由系统管理员吊销这把密钥（下一版用现在的主密钥包装）`)
  }
}

/** HKDF-SHA256，salt 为空；返回的字节由调用方清零或保留 */
function derive(masterKey: Buffer, info: string, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), info, length))
}

function aadOf(owner: LocalKeyOwner, masterKeyIdHex: string): Buffer {
  return Buffer.from(JSON.stringify([AAD_FORMAT, owner.userId, owner.version, masterKeyIdHex]), 'utf8')
}

/** 用户与版本的写法不对是接线错误（不是数据问题）：直接报错，不带进 AAD */
function requireOwner(owner: LocalKeyOwner): void {
  if (!CANONICAL_UUID.test(owner.userId))
    throw new Error('本机密钥的用户 id 要用数据库给出的小写写法')
  if (!Number.isSafeInteger(owner.version) || owner.version < 1)
    throw new Error(`本机密钥的版本要是从 1 起的整数：${owner.version}`)
}

export interface MasterKeyringOptions {
  /** 每次包装的 IV（12 字节）：默认安全随机数；已知答案测试注入固定的 */
  readonly randomIv?: () => Buffer
}

/** 主密钥环：标识 → 包装键。包装一律用当前的，解包按行上的标识查环（本期只有当前一把） */
export class MasterKeyring {
  readonly #currentId: Buffer
  readonly #keys: ReadonlyMap<string, KeyObject>
  readonly #randomIv: () => Buffer

  private constructor(currentId: Buffer, wrapKey: KeyObject, randomIv: () => Buffer) {
    this.#currentId = currentId
    this.#keys = new Map([[currentId.toString('hex'), wrapKey]])
    this.#randomIv = randomIv
  }

  /** 从配置里的主密钥（32 字节随机数的 base64，配置已经校验过写法）派生包装键与标识；派生用的字节随即清零 */
  static fromMasterKey(masterKey: Secret, options: MasterKeyringOptions = {}): MasterKeyring {
    const ikm = Buffer.from(masterKey.reveal(), 'base64')
    try {
      if (ikm.length !== MASTER_KEY_BYTES)
        throw new Error(`主密钥要是 ${MASTER_KEY_BYTES} 字节`)
      const wrapKeyBytes = derive(ikm, WRAP_KEY_INFO, WRAP_KEY_BYTES)
      try {
        return new MasterKeyring(derive(ikm, MASTER_KEY_ID_INFO, MASTER_KEY_ID_BYTES), createSecretKey(wrapKeyBytes), options.randomIv ?? (() => randomBytes(IV_BYTES)))
      }
      finally {
        wrapKeyBytes.fill(0)
      }
    }
    finally {
      ikm.fill(0)
    }
  }

  /** 现在配置的主密钥的标识（十六进制，不是机密） */
  get currentMasterKeyId(): string {
    return this.#currentId.toString('hex')
  }

  /** 用当前的主密钥包装一把原始密钥（32 字节）：返回标识与 60 字节的包装结果。原始密钥由调用方清零 */
  wrap(rawKey: Buffer, owner: LocalKeyOwner): WrappedLocalKey {
    requireOwner(owner)
    if (rawKey.length !== LOCAL_KEY_BYTES)
      throw new Error(`本机密钥要是 ${LOCAL_KEY_BYTES} 字节`)
    const iv = this.#randomIv()
    if (iv.length !== IV_BYTES)
      throw new Error(`包装的 IV 要是 ${IV_BYTES} 字节`)
    const masterKeyIdHex = this.currentMasterKeyId
    const cipher = createCipheriv(CIPHER, this.#wrapKeyOf(masterKeyIdHex), iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aadOf(owner, masterKeyIdHex))
    const wrappedKey = Buffer.concat([iv, cipher.update(rawKey), cipher.final(), cipher.getAuthTag()])
    return { masterKeyId: Buffer.from(this.#currentId), wrappedKey }
  }

  /**
   * 解开库里的一把：按行上的标识查环；不认识的主密钥、包装结果对不上（标签校验失败）都抛 LocalKeyUnwrapError（不带密钥材料）。
   * 返回的原始密钥由调用方用完清零
   */
  unwrap(stored: WrappedLocalKey, owner: LocalKeyOwner): Buffer {
    requireOwner(owner)
    const masterKeyIdHex = stored.masterKeyId.toString('hex')
    const wrapKey = this.#keys.get(masterKeyIdHex)
    if (wrapKey === undefined)
      throw new LocalKeyUnwrapError('unknown_master_key', owner.userId, owner.version, masterKeyIdHex, this.currentMasterKeyId)
    const { wrappedKey } = stored
    // 表上的 CHECK 钉住 60 字节，这里按固定位置切出 16 字节的标签；长度不对同样当作对不上
    if (wrappedKey.length !== WRAPPED_KEY_BYTES)
      throw new LocalKeyUnwrapError('not_authentic', owner.userId, owner.version, masterKeyIdHex, this.currentMasterKeyId)
    const decipher = createDecipheriv(CIPHER, wrapKey, wrappedKey.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES })
    decipher.setAAD(aadOf(owner, masterKeyIdHex))
    decipher.setAuthTag(wrappedKey.subarray(IV_BYTES + LOCAL_KEY_BYTES))
    const plain = decipher.update(wrappedKey.subarray(IV_BYTES, IV_BYTES + LOCAL_KEY_BYTES))
    try {
      return Buffer.concat([plain, decipher.final()])
    }
    catch {
      // 标签校验失败（OpenSSL 的"Unsupported state or unable to authenticate data"）：说明里只有原因，不挂原来的异常
      throw new LocalKeyUnwrapError('not_authentic', owner.userId, owner.version, masterKeyIdHex, this.currentMasterKeyId)
    }
    finally {
      plain.fill(0)
    }
  }

  #wrapKeyOf(masterKeyIdHex: string): KeyObject {
    const key = this.#keys.get(masterKeyIdHex)
    if (key === undefined)
      throw new Error('主密钥环里没有当前的主密钥')
    return key
  }
}

/** 一把新的本机密钥：32 字节安全随机数。调用方用完清零 */
export function generateLocalKey(): Buffer {
  return randomBytes(LOCAL_KEY_BYTES)
}
