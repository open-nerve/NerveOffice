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
  'networks': z.record(z.string(), z.object({ labels: environmentSchema })),
  'volumes': z.record(z.string(), z.object({ labels: environmentSchema })),
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

const containerEnvFile = variables(renderEnvFile(createSettings({ runId: '0199a2c4-1111-7000-8000-111111111111', composeFile: 'c', envFile: 'e', httpsPort: 1, databasePort: 2 })))

describe('测试环境的编排与变量（deploy/test，M3-P6 设计 §3.9）', () => {
  it('GC 开关与宽限进入应用容器，但备份声明不填默认值', () => {
    const { 'x-nerve-environment': shared, services } = compose()
    const expected = {
      NERVE_ASSET_GC_ENABLED: `\${NERVE_ASSET_GC_ENABLED:-true}`,
      NERVE_ASSET_GC_INTERVAL_MS: `\${NERVE_ASSET_GC_INTERVAL_MS:-3600000}`,
      NERVE_ASSET_GC_BATCH: `\${NERVE_ASSET_GC_BATCH:-100}`,
      NERVE_ASSET_GC_GRACE_DAYS: `\${NERVE_ASSET_GC_GRACE_DAYS:-30}`,
      NERVE_BACKUP_RETENTION_DAYS: `\${NERVE_BACKUP_RETENTION_DAYS:-}`,
      NERVE_ASSET_GC_RECOVERY_BEFORE: `\${NERVE_ASSET_GC_RECOVERY_BEFORE:-}`,
    }
    expect(services.app?.environment).toMatchObject(expected)
    for (const name of Object.keys(expected))
      expect(shared).not.toHaveProperty(name)
  })
  it('图片仅给应用挂私有持久卷，迁移/数据库/代理没有图片卷；只读根和非 Web 资源位置保持', () => {
    const { 'x-nerve-environment': shared, services } = compose()
    const app = services.app
    expect(app?.environment?.NERVE_ASSET_ROOT).toBe('/var/lib/nerve-office/assets')
    expect(shared).not.toHaveProperty('NERVE_ASSET_ROOT')
    expect(app?.volumes).toContain('assets:/var/lib/nerve-office/assets')
    expect(app?.read_only).toBe(true)
    expect(app?.mem_limit).toBe('4g')
    expect(app?.environment?.NERVE_ASSET_QUOTA_BYTES).toBe(`\${NERVE_ASSET_QUOTA_BYTES:-10737418240}`)
    expect(app?.environment?.NERVE_ASSET_QUOTA_COUNT).toBe(`\${NERVE_ASSET_QUOTA_COUNT:-100000}`)
    for (const name of ['db', 'migrate', 'caddy']) {
      const volumes = z.array(z.string()).parse(services[name]?.volumes ?? [])
      expect(volumes.some(volume => volume.startsWith('assets:')), name).toBe(false)
    }
  })

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

it('所有测试服务、网络、卷带运行归属；手工默认 manual 不会被接管', () => {
  const { services, networks, volumes } = compose()
  for (const value of [...Object.values(services), ...Object.values(networks), ...Object.values(volumes)]) {
    expect(value.labels).toEqual({
      'org.nerve-office.test.run': `\${NERVE_TEST_RUN_ID:-manual}`,
      'org.nerve-office.test.repo': `\${NERVE_TEST_REPO_HASH:-manual}`,
    })
  }
})
