import { z } from 'zod'

/**
 * 请求里的 UUID（路径、查询参数与请求体里的 id）：大小写都接受，统一转成小写（RFC 9562 §4：输入不区分大小写，输出用小写）。
 * 数据库的 uuid 比较不分大小写，服务端的代码却按字符串比较（是不是本人、按 id 找条目、审计的明细、收回写入权的范围）：
 * 在边界上统一成数据库给出的写法，服务端只见到小写（M2-P2 审查 A1）。响应里的 id 本来就是小写，照旧用 z.uuid()。
 */
export const uuidSchema = z.uuid().transform(value => value.toLowerCase())
