// 本机密钥的写法（M3-P6 设计 §3.5）：字节数与 base64 的写法。不引用 zod：页面在测试构建的探针里导入本机密钥时只引用这里
// （M4-P1 S6：探针引用带 zod 的契约模块会让测试构建里两个入口的分块与生产的不同，zod 的结构可能先于关掉 JIT 求值），与 asset-address.ts 同一个做法

/** 本机密钥的字节数（AES-256） */
export const LOCAL_KEY_BYTES = 32

/**
 * 32 字节的标准 base64（带填充、规范写法）：44 个字符，以一个 = 结尾。前 42 个字符各带 6 位；第 43 个字符只有高 4 位是数据、
 * 低 2 位必须是 0（取值是 4 的倍数：A E I M Q U Y c g k o s w 0 4 8），所以 32 字节恰好只有这一种写法
 */
export const LOCAL_KEY_PATTERN_SOURCE = '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
