import { describe, expect, it } from 'vitest'
import {
  clientAddressProblems,
  composeArgs,
  createSettings,
  databaseUrl,
  memoryUsage,
  parseAuditAddresses,
  playwrightEnvironment,
  publicOrigin,
  renderEnvFile,
  staleRuns,
} from './container-e2e.ts'

/** 每次给出不同的字节：0x01…、0x02…、0x03… */
function counter(): (size: number) => Uint8Array {
  let next = 0
  return (size) => {
    next += 1
    return new Uint8Array(size).fill(next)
  }
}

const settings = createSettings({ pid: 4242, composeFile: '/repo/deploy/test/compose.yaml', envFile: '/tmp/e2e/test.env', httpsPort: 18443, databasePort: 15432, random: counter() })

describe('容器 E2E 的编排参数（P5 设计 §3.6）', () => {
  it('项目名与镜像标签带进程号；三个密码各自随机，只用十六进制字符', () => {
    expect(settings.project).toBe('nerve-office-e2e-4242')
    expect(settings.image).toBe('nerve-office:e2e-4242')
    expect(settings.passwords).toEqual({ admin: '01'.repeat(16), owner: '02'.repeat(16), app: '03'.repeat(16) })
    const real = createSettings({ pid: 1, composeFile: 'c', envFile: 'e', httpsPort: 1, databasePort: 2 }).passwords
    expect(new Set([real.admin, real.owner, real.app]).size).toBe(3)
    expect(real.admin).toMatch(/^[\da-f]{32}$/)
  })

  it('变量文件：镜像、三个密码、两个端口；按地址的登录失败上限调高', () => {
    expect(renderEnvFile(settings)).toBe([
      'NERVE_IMAGE=nerve-office:e2e-4242',
      `NERVE_DB_ADMIN_PASSWORD=${'01'.repeat(16)}`,
      `NERVE_DB_OWNER_PASSWORD=${'02'.repeat(16)}`,
      `NERVE_DB_APP_PASSWORD=${'03'.repeat(16)}`,
      'NERVE_TEST_HTTPS_PORT=18443',
      'NERVE_TEST_DB_PORT=15432',
      'NERVE_LOG_LEVEL=info',
      'NERVE_LOGIN_IP_MAX_FAILURES=100000',
      '',
    ].join('\n'))
  })

  it('docker compose 的参数带上项目、编排文件与变量文件', () => {
    expect(composeArgs(settings, 'kill', '-s', 'KILL', 'app')).toEqual(['compose', '-p', 'nerve-office-e2e-4242', '-f', '/repo/deploy/test/compose.yaml', '--env-file', '/tmp/e2e/test.env', 'kill', '-s', 'KILL', 'app'])
  })

  it('交给 Playwright 的环境变量：外部模式的地址、管理员连接的库、浏览器与编排', () => {
    expect(publicOrigin(settings)).toBe('https://localhost:18443')
    expect(databaseUrl(settings)).toBe(`postgres://postgres:${'01'.repeat(16)}@127.0.0.1:15432/nerve_office`)
    expect(playwrightEnvironment(settings, ['chromium', 'webkit'])).toEqual({
      E2E_BASE_URL: 'https://localhost:18443',
      E2E_DATABASE_URL: databaseUrl(settings),
      E2E_BROWSERS: 'chromium,webkit',
      E2E_COMPOSE_PROJECT: 'nerve-office-e2e-4242',
      E2E_COMPOSE_FILE: '/repo/deploy/test/compose.yaml',
      E2E_COMPOSE_ENV_FILE: '/tmp/e2e/test.env',
    })
  })

  it('遗留的项目与镜像：前缀相同、进程已经不在；别的名字与还在运行的不算', () => {
    const alive = new Set([100])
    expect(staleRuns(['nerve-office-e2e-100', 'nerve-office-e2e-200', 'nerve-office-test', 'nerve-office-e2e-x', 'nerve-office-e2e-', 'other-e2e-300'], 'nerve-office-e2e-', pid => alive.has(pid)))
      .toEqual(['nerve-office-e2e-200'])
    expect(staleRuns(['nerve-office:e2e-100', 'nerve-office:e2e-300', 'nerve-office:test'], 'nerve-office:e2e-', pid => alive.has(pid)))
      .toEqual(['nerve-office:e2e-300'])
  })
})

describe('两个客户端地址的核对（DEF-014）', () => {
  it('psql 的输出解析成请求标识到地址，忽略空行与没有地址的记录', () => {
    expect(parseAuditAddresses('check-host|192.168.0.1\ncheck-network|192.168.0.5\n\nno-address|\n')).toEqual(new Map([['check-host', '192.168.0.1'], ['check-network', '192.168.0.5']]))
  })

  it('两个地址不同，也都不是 Caddy 的：没有问题', () => {
    expect(clientAddressProblems({ host: '192.168.0.1', network: '192.168.0.5', proxy: ['192.168.0.4'] })).toEqual([])
  })

  it('没有设 NERVE_TRUST_PROXY：两次都是 Caddy 的地址', () => {
    expect(clientAddressProblems({ host: '192.168.0.4', network: '192.168.0.4', proxy: ['192.168.0.4'] })).toEqual([
      '两次的客户端地址相同（192.168.0.4）：应用没有区分出真实的来源',
      '本机那次的客户端地址是 Caddy 的地址（192.168.0.4）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）',
      '编排网络里那次的客户端地址是 Caddy 的地址（192.168.0.4）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）',
    ])
  })

  it('缺少审计记录', () => {
    expect(clientAddressProblems({ host: undefined, network: undefined, proxy: [] })).toEqual(['本机那次登录失败没有审计记录', '编排网络里那次登录失败没有审计记录'])
  })
})

describe('docker 输出的解析', () => {
  it('内存用量取斜线之前的部分', () => {
    expect(memoryUsage('45.2MiB / 7.66GiB')).toBe('45.2MiB')
    expect(memoryUsage('')).toBe('')
  })
})
