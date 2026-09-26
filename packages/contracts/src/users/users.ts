import { z } from 'zod'

/** 系统角色（00 号计划书 §5.2）。新增取值时，同时用迁移更新 users.system_role 的 CHECK 约束。 */
export const USER_SYSTEM_ROLES = ['admin', 'member'] as const
export type UserSystemRole = (typeof USER_SYSTEM_ROLES)[number]

/** 账户状态：M2 加上停用（disabled）。新增取值时，同时用迁移更新 users.status 的 CHECK 约束。 */
export const USER_STATUSES = ['active'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/**
 * 用户名的规范写法：3–32 个字符，只有小写字母、数字与 . _ -，以字母或数字开头。
 * 数据库的 CHECK 约束用同一个正则（PostgreSQL 的 ~ 运算符）。
 */
export const USERNAME_PATTERN_SOURCE = '^[a-z0-9][a-z0-9._-]{2,31}$'
const USERNAME_PATTERN = new RegExp(USERNAME_PATTERN_SOURCE)

/** 登录与创建账户时都先规范化：去掉首尾空白，转成小写。用户名因此不区分大小写。 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase()
}

/** 创建账户时的用户名：规范化之后必须符合规范写法。 */
export const usernameSchema = z.string()
  .transform(normalizeUsername)
  .pipe(z.string().regex(USERNAME_PATTERN, '用户名为 3–32 个字符，只能包含小写字母、数字与 . _ -，并以字母或数字开头'))

/** 按码点计的长度：与 PostgreSQL 的 char_length 一致（JavaScript 的 length 按 UTF-16 计，表情符号算两个）。 */
export function codePointLength(value: string): number {
  return [...value].length
}

// eslint-disable-next-line no-control-regex -- 显示名与密码里不允许控制字符，要匹配的正是它们
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/

export const DISPLAY_NAME_MAX_LENGTH = 64

/** 显示名：去掉首尾空白之后 1–64 个字符，不含控制字符。 */
export const displayNameSchema = z.string()
  .trim()
  .refine(value => codePointLength(value) >= 1 && codePointLength(value) <= DISPLAY_NAME_MAX_LENGTH, `显示名为 1–${DISPLAY_NAME_MAX_LENGTH} 个字符`)
  .refine(value => !CONTROL_CHARACTERS.test(value), '显示名不能包含控制字符')

export const NEW_PASSWORD_MIN_LENGTH = 12
export const NEW_PASSWORD_MAX_LENGTH = 256

/**
 * 设置密码时的规则（NIST SP 800-63B）：12–256 个字符，不要求字符种类。
 * 不含控制字符：浏览器的密码框输入不了它们，混进来的（例如标准输入多了一个换行）会让这个密码再也登录不上。
 * 只用于设置密码；登录时不向外透露这些规则（见 auth 的登录请求）。
 */
export const newPasswordSchema = z.string()
  .refine(value => codePointLength(value) >= NEW_PASSWORD_MIN_LENGTH, `密码至少 ${NEW_PASSWORD_MIN_LENGTH} 个字符`)
  .refine(value => codePointLength(value) <= NEW_PASSWORD_MAX_LENGTH, `密码最多 ${NEW_PASSWORD_MAX_LENGTH} 个字符`)
  .refine(value => !CONTROL_CHARACTERS.test(value), '密码不能包含控制字符（例如换行、制表符）')
