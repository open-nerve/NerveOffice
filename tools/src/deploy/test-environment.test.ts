// 测试环境的编排与变量（deploy/test）与容器 E2E 的变量文件对得上（M3-P6 设计 §3.9）：本机密钥的主密钥只给应用容器、必填；
// 编排里必填的变量，容器 E2E 的变量文件都给了（少一个，docker compose 一条命令都执行不了）；.env.example 列出了这些变量，
// 主密钥的占位不是合法的取值（不换掉，应用就拒绝启动）。
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { readText } from '../shared/repo.ts'
import { COMPOSE_FILE, createSettings, MASTER_KEY_VARIABLE, renderEnvFile } from './container-e2e.ts'

const ENV_EXAMPLE = 'deploy/test/.env.example'
/** 主密钥合法的写法（与应用的配置相同：32 字节的标准 base64，openssl rand -base64 32 的输出） */
const MASTER_KEY_PATTERN = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

const environmentSchema = z.record(z.string(), z.unknown())
const composeSchema = z.object({
  'x-nerve-environment': environmentSchema,
  'services': z.record(z.string(), z.object({ environment: environmentSchema.optional() }).loose()),
})

/** 编排文件：合并键（<<）展开之后 */
function compose(): z.infer<typeof composeSchema> {
  return composeSchema.parse(parse(readText(COMPOSE_FILE), { merge: true }))
}

/** 变量文件的各项（不算注释与空行）：名字 → 取值 */
function variables(text: string): Map<string, string> {
  return new Map(text.split('\n').flatMap((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    return match?.[1] === undefined ? [] : [[match[1], match[2] ?? ''] as const]
  }))
}

const containerEnvFile = variables(renderEnvFile(createSettings({ pid: 1, composeFile: 'c', envFile: 'e', httpsPort: 1, databasePort: 2 })))

describe('测试环境的编排与变量（deploy/test，M3-P6 设计 §3.9）', () => {
  it('本机密钥的主密钥只在应用容器的配置里，而且必填（没给时编排直接报错）：迁移、共用的配置、数据库与代理都没有', () => {
    const { 'x-nerve-environment': shared, services } = compose()
    expect(services.app?.environment?.[MASTER_KEY_VARIABLE]).toMatch(new RegExp(`^\\$\\{${MASTER_KEY_VARIABLE}:\\?[^}]+\\}$`))
    expect(shared).not.toHaveProperty(MASTER_KEY_VARIABLE)
    for (const service of ['db', 'migrate', 'caddy']) {
      expect(services[service], service).toBeDefined()
      expect(services[service]?.environment ?? {}, service).not.toHaveProperty(MASTER_KEY_VARIABLE)
    }
  })

  it('编排里必填的变量（没给时编排直接报错的），容器 E2E 的变量文件都给了', () => {
    const required = new Set([...readText(COMPOSE_FILE).matchAll(/\$\{(\w+):\?/g)].flatMap(match => (match[1] === undefined ? [] : [match[1]])))
    expect(required).toContain(MASTER_KEY_VARIABLE)
    for (const name of required)
      expect(containerEnvFile.get(name), name).toBeTruthy()
  })

  it('.env.example 列出了容器 E2E 的变量文件里的每一项；主密钥的占位不是合法的取值', () => {
    const example = variables(readText(ENV_EXAMPLE))
    for (const name of containerEnvFile.keys())
      expect(example.has(name), name).toBe(true)
    expect(example.get(MASTER_KEY_VARIABLE)).not.toMatch(MASTER_KEY_PATTERN)
    expect(containerEnvFile.get(MASTER_KEY_VARIABLE)).toMatch(MASTER_KEY_PATTERN)
  })
})
