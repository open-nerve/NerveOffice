import { describe, expect, it } from 'vitest'
import {
  clientAddressProblems,
  composeArgs,
  createSettings,
  databaseUrl,
  FORGED_CLIENT_ADDRESS,
  mebibytes,
  memoryBytes,
  parseAuditAddresses,
  playwrightEnvironment,
  PROXIED_PROBES,
  proxiedProbeProblems,
  publicOrigin,
  publishedPortProblems,
  renderEnvFile,
  staleRuns,
  staleTemporaryDirectories,
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

  it('交给 Playwright 的环境变量：外部模式的地址、管理员连接的库、浏览器、编排与编排脚本的进程号', () => {
    expect(publicOrigin(settings)).toBe('https://localhost:18443')
    expect(databaseUrl(settings)).toBe(`postgres://postgres:${'01'.repeat(16)}@127.0.0.1:15432/nerve_office`)
    expect(playwrightEnvironment(settings, ['chromium', 'webkit'], 4242)).toEqual({
      E2E_BASE_URL: 'https://localhost:18443',
      E2E_DATABASE_URL: databaseUrl(settings),
      E2E_BROWSERS: 'chromium,webkit',
      E2E_COMPOSE_PROJECT: 'nerve-office-e2e-4242',
      E2E_COMPOSE_FILE: '/repo/deploy/test/compose.yaml',
      E2E_COMPOSE_ENV_FILE: '/tmp/e2e/test.env',
      E2E_RUNNER_PID: '4242',
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

describe('中断的运行留下的临时目录（审查 B6）', () => {
  it('前缀、进程号与随机后缀，进程已经不在的才删', () => {
    const alive = new Set([100])
    expect(staleTemporaryDirectories(['nerve-office-e2e-100-AbC123', 'nerve-office-e2e-200-XyZ789', 'nerve-office-e2e-300', 'nerve-office-test-400-a', 'other'], pid => alive.has(pid)))
      .toEqual(['nerve-office-e2e-200-XyZ789'])
  })
})

describe('客户端地址的核对（DEF-014）', () => {
  it('psql 的输出解析成请求标识到地址，忽略空行与没有地址的记录', () => {
    expect(parseAuditAddresses('check-host|192.168.0.1\ncheck-network|192.168.0.5\n\nno-address|\n')).toEqual(new Map([['check-host', '192.168.0.1'], ['check-network', '192.168.0.5']]))
  })

  it('两个地址不同，也都不是 Caddy 的；伪造的转发头没有被采信：没有问题', () => {
    expect(clientAddressProblems({ host: '192.168.0.1', network: '192.168.0.5', forged: '192.168.0.1', proxy: ['192.168.0.4'] })).toEqual([])
  })

  it('代理采信了客户端带来的 X-Forwarded-For（审查 B5）', () => {
    expect(clientAddressProblems({ host: '192.168.0.1', network: '192.168.0.5', forged: FORGED_CLIENT_ADDRESS, proxy: ['192.168.0.4'] }))
      .toEqual([`审计记下了客户端自己写的 X-Forwarded-For（${FORGED_CLIENT_ADDRESS}）：代理采信了客户端带来的转发头，任何人都能冒充别的地址`])
  })

  it('没有设 NERVE_TRUST_PROXY：两次都是 Caddy 的地址', () => {
    expect(clientAddressProblems({ host: '192.168.0.4', network: '192.168.0.4', forged: '192.168.0.4', proxy: ['192.168.0.4'] })).toEqual([
      '两次的客户端地址相同（192.168.0.4）：应用没有区分出真实的来源',
      '本机那次的客户端地址是 Caddy 的地址（192.168.0.4）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）',
      '编排网络里那次的客户端地址是 Caddy 的地址（192.168.0.4）：应用没有采信代理转发的地址（检查 NERVE_TRUST_PROXY）',
    ])
  })

  it('缺少审计记录', () => {
    expect(clientAddressProblems({ host: undefined, network: undefined, forged: undefined, proxy: [] }))
      .toEqual(['本机那次登录失败没有审计记录', '编排网络里那次登录失败没有审计记录', '带着伪造的 X-Forwarded-For 那次登录失败没有审计记录'])
  })

  it('应用的端口发布到了主机（审查 B5）；命令失败时查不出来，同样算问题（复验 RB4）', () => {
    expect(publishedPortProblems(0, ':0\n')).toEqual([])
    expect(publishedPortProblems(0, '0.0.0.0:32768\n[::]:32768\n')).toEqual(['应用的端口发布到了主机（0.0.0.0:32768、[::]:32768）：只能让代理连到应用'])
    expect(publishedPortProblems(1, '')).toEqual(['查不到应用的端口有没有发布（docker compose port 的退出码 1）'])
    expect(publishedPortProblems(null, '')).toEqual(['查不到应用的端口有没有发布（docker compose port 的退出码 null）'])
  })
})

describe('经代理访问探针（审查 A1）', () => {
  const allAsExpected = new Map(PROXIED_PROBES.map(({ path, status }) => [path, { status, headers: {} }]))

  it('存活探针转发；就绪探针的几种写法（末尾斜杠、大小写）都被屏蔽', () => {
    expect(PROXIED_PROBES.map(probe => probe.path)).toEqual(['/api/health/live', '/api/health/ready', '/api/health/ready/', '/api/HEALTH/READY'])
    expect(proxiedProbeProblems(allAsExpected)).toEqual([])
  })

  it('只屏蔽了精确的地址：带末尾斜杠的就绪探针漏到应用', () => {
    expect(proxiedProbeProblems(new Map([...allAsExpected, ['/api/health/ready/', { status: 200, headers: {} }]]))).toEqual(['经代理请求 /api/health/ready/ 得到 200，期望 404'])
  })

  it('代理自己生成的响应带着 Server 或 Via（复验 RB3）', () => {
    expect(proxiedProbeProblems(new Map([...allAsExpected, ['/api/health/ready', { status: 404, headers: { server: 'Caddy', via: '1.1 Caddy' } }]]))).toEqual([
      '经代理请求 /api/health/ready 的响应带着 server 头：不能暴露代理的软件',
      '经代理请求 /api/health/ready 的响应带着 via 头：不能暴露代理的软件',
    ])
  })

  it('连不上与没有结果都算问题', () => {
    expect(proxiedProbeProblems(new Map([...allAsExpected, ['/api/health/live', { status: 0, headers: {} }]]))).toEqual(['经代理请求 /api/health/live 没有响应，期望 200'])
    expect(proxiedProbeProblems(new Map())).toHaveLength(4)
  })
})

describe('docker 输出的解析', () => {
  it('内存用量取斜线之前的部分，按单位换成字节；读不出来时是 undefined', () => {
    expect(memoryBytes('45.5MiB / 7.66GiB')).toBe(45.5 * 1024 ** 2)
    expect(memoryBytes('1.5GiB / 7.66GiB')).toBe(1.5 * 1024 ** 3)
    expect(memoryBytes('512kB / 1GB')).toBe(512_000)
    expect(memoryBytes('0B / 0B')).toBe(0)
    expect(memoryBytes('')).toBeUndefined()
    expect(memoryBytes('--')).toBeUndefined()
    expect(memoryBytes('12parsecs / 1GB')).toBeUndefined()
    expect(mebibytes(200.25 * 1024 ** 2)).toBe('200.3 MiB')
  })
})
