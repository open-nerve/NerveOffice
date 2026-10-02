import { describe, expect, it } from 'vitest'
import {
  clientAddressProblems,
  composeArgs,
  createSettings,
  databaseUrl,
  describeIdleMemory,
  DISTRIBUTED_LICENSE_FILES,
  distributedFileProblems,
  duBytes,
  FILE_SIZES_SCRIPT,
  FORGED_CLIENT_ADDRESS,
  IDLE_MEMORY_SAMPLING,
  imageSizeArgs,
  mebibytes,
  median,
  megabytes,
  MEMORY_SAMPLE_INTERVAL_MS,
  memoryBytes,
  parseAuditAddresses,
  playwrightEnvironment,
  PROXIED_PROBES,
  proxiedProbeProblems,
  publicOrigin,
  publishedPortProblems,
  renderEnvFile,
  sampleMemory,
  serverRequestId,
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
  it('应用给请求生成的请求标识：只认 UUID（它要拼进查审计的 SQL），取不到或不是 UUID 时为空（M2-P6 复核 C2）', () => {
    expect(serverRequestId('0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d')).toBe('0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d')
    expect(serverRequestId(' 0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d\n')).toBe('0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d')
    for (const value of [undefined, '', 'client-trace-1', '\'); DROP TABLE audit_events; --', ['0199a2c4-1f2e-4a3b-8c4d-5e6f7a8b9c0d']])
      expect(serverRequestId(value), JSON.stringify(value)).toBeUndefined()
  })

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

describe('随镜像分发的许可文件', () => {
  it('都在、都不是空的：没有问题', () => {
    const output = DISTRIBUTED_LICENSE_FILES.map(file => `${file}\t1024`).join('\n')
    expect(distributedFileProblems(DISTRIBUTED_LICENSE_FILES, 0, `${output}\n`)).toEqual([])
  })

  it('缺了、是空的、没有量到、命令失败：都算问题', () => {
    const [license = '', server = '', web = ''] = DISTRIBUTED_LICENSE_FILES
    expect(distributedFileProblems(DISTRIBUTED_LICENSE_FILES, 0, `${license}\t-1\n${server}\t0\n`)).toEqual([
      `镜像里没有 ${license}`,
      `镜像里的 ${server} 是空的`,
      `镜像里没有 ${web}`,
    ])
    expect(distributedFileProblems(DISTRIBUTED_LICENSE_FILES, 1, '')).toEqual(['量不了镜像里的许可文件（退出码 1）'])
    expect(distributedFileProblems(DISTRIBUTED_LICENSE_FILES, null, '')).toEqual(['量不了镜像里的许可文件（退出码 null）'])
  })

  it('量大小的脚本：每个参数一行，缺的文件是 -1', async () => {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(process.execPath, ['-e', FILE_SIZES_SCRIPT, import.meta.filename, '/nerve-office-no-such-file'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const [present = '', missing = ''] = result.stdout.trim().split('\n')
    const [file, size] = present.split('\t')
    expect(file).toBe(import.meta.filename)
    expect(Number(size)).toBeGreaterThan(0)
    expect(missing).toBe('/nerve-office-no-such-file\t-1')
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

  it('镜像体积在一次性的容器里合计镜像里的文件：不联网、以 root 读全部目录、不跨文件系统（不算 /proc 等）', () => {
    expect(imageSizeArgs('nerve-office:e2e-42')).toEqual(['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'du', 'nerve-office:e2e-42', '-sxb', '/'])
  })

  it('中位数：奇数个取中间那个，偶数个取中间两个的平均，与顺序无关；没有数时是 undefined', () => {
    expect(median([244, 210, 211])).toBe(211)
    expect(median([212, 210, 209, 244])).toBe(211)
    expect(median([5])).toBe(5)
    expect(median([])).toBeUndefined()
  })

  it('du 的输出只认根目录的一行字节数；读不出来时是 undefined', () => {
    expect(duBytes('285717915\t/\n')).toBe(285_717_915)
    expect(duBytes('  267140309 /  ')).toBe(267_140_309)
    expect(duBytes('')).toBeUndefined()
    expect(duBytes('du: cannot access \'/\': Permission denied')).toBeUndefined()
    expect(duBytes('4096\t/app\n')).toBeUndefined()
    expect(duBytes('12\t/\n34\t/\n')).toBeUndefined()
    expect(duBytes('99999999999999999999\t/')).toBeUndefined()
    expect(megabytes(285_717_915)).toBe('285.7 MB')
  })
})

describe('空闲内存的取样（ADR-001，M2-P6 第 6 片复核第二批）', () => {
  const MiB = 1024 ** 2

  /** 假的取样：依次给出 values，记下每次等了多久、在第几次之后收到终止信号 */
  function fakeSampler(values: readonly (number | undefined)[], stopAfter = Number.POSITIVE_INFINITY) {
    const waits: number[] = []
    let taken = 0
    return {
      waits,
      sampler: {
        sample: async () => values[taken++],
        wait: async (ms: number) => {
          waits.push(ms)
        },
        stopped: () => taken >= stopAfter,
      },
    }
  }

  it('部署核对之后先等 10 秒，再每 2 秒（与 E2E 期间的取样相同）取一次，共 5 次', () => {
    expect(IDLE_MEMORY_SAMPLING).toEqual({ settleMs: 10_000, samples: 5, intervalMs: MEMORY_SAMPLE_INTERVAL_MS })
    expect(MEMORY_SAMPLE_INTERVAL_MS).toBe(2_000)
  })

  it('先等 settleMs、再隔 intervalMs 依次取样，按顺序返回各次的值；取不到的一次记为 undefined', async () => {
    const { waits, sampler } = fakeSampler([244 * MiB, undefined, 210 * MiB])
    expect(await sampleMemory({ settleMs: 10_000, samples: 3, intervalMs: 2_000 }, sampler)).toEqual([244 * MiB, undefined, 210 * MiB])
    expect(waits).toEqual([10_000, 2_000, 2_000])
  })

  it('收到终止信号就不再等、不再取，返回已经取到的', async () => {
    const stoppedAfterTwo = fakeSampler([1, 2, 3, 4, 5], 2)
    expect(await sampleMemory(IDLE_MEMORY_SAMPLING, stoppedAfterTwo.sampler)).toEqual([1, 2])
    expect(stoppedAfterTwo.waits).toEqual([10_000, 2_000])
    const stoppedBefore = fakeSampler([1], 0)
    expect(await sampleMemory(IDLE_MEMORY_SAMPLING, stoppedBefore.sampler)).toEqual([])
    expect(stoppedBefore.waits).toEqual([])
  })

  it('说明给出取到的各次的中位数，并列出各次的值；一次也没取到时说明没有取到', () => {
    // 刚算完 Argon2 的一次（244）不影响中位数
    expect(describeIdleMemory(IDLE_MEMORY_SAMPLING, [244 * MiB, 211.5 * MiB, undefined, 210 * MiB, 212 * MiB]))
      .toBe('211.8 MiB（部署核对之后等 10 秒、每 2 秒取一次，4 次的中位数；各次 244.0、211.5、没取到、210.0、212.0 MiB）')
    expect(describeIdleMemory(IDLE_MEMORY_SAMPLING, [undefined, undefined])).toBe('（没有取到）')
    expect(describeIdleMemory(IDLE_MEMORY_SAMPLING, [])).toBe('（没有取到）')
  })
})
