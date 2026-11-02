export const GIB = 1024 ** 3
export const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright@sha256:a0f4498920a5dbac63196d9140ed738ef00470f27e2e74029abd8850b7bd5717'
export const NODE_IMAGE = 'node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
export const DATABASE_IMAGE = 'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'

export const linuxEnvironmentFile = (scratch: string) => `${scratch}/tmp/linux-browser/runtime.env`

export function browserPlan(project: string, scratch: string, labels: readonly string[]) {
  const common = ['create', '--pull=never', '--platform=linux/arm64', ...labels.flatMap(label => ['--label', label])]
  const select = ['--project=chromium', '--workers=1', '--grep=US-M5-14']
  return {
    groups: [
      { name: 'calibration', count: 1, args: ['security/csp.spec.ts', ...select] },
      { name: 'stories', count: 13, args: ['editor/image-input.spec.ts', 'editor/image-policy.spec.ts', 'editor/links.spec.ts', 'editor/paste-images.spec.ts', ...select] },
    ],
    runner: [...common, '--name', `${project}-runner`, '--network', `${project}_default`, '--cpus=3', '--memory=4g', '--memory-swap=4g', '--shm-size=1g', '--volume', `${project}_assets:/owned`, '--mount', `type=volume,source=${project}_assets,target=/opt/node,volume-subpath=node,readonly`, '--workdir=/owned/source', '--env-file', linuxEnvironmentFile(scratch), '--env=PATH=/owned/pnpm/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '--env=PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', '--env=PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', '--env=TMPDIR=/owned/tmp', '--env=TMP=/owned/tmp', '--env=TEMP=/owned/tmp', '--env=npm_config_cache=/owned/npm-cache', '--env=XDG_CACHE_HOME=/owned/cache', PLAYWRIGHT_IMAGE, '/bin/sh', '/owned/source/tools/test-resources/linux-browser-bootstrap.sh'],
    preparation: [...common, '--name', `${project}-node`, '--network=none', '--cpus=1', '--memory=512m', '--memory-swap=512m', '--volume', `${project}_assets:/owned`, NODE_IMAGE, '/bin/sh', '-eu', '-c', 'mkdir -p /owned/node /owned/source/.test-resources/runs /owned/evidence /owned/tmp; cp -a /usr/local/. /owned/node/'],
    meter: [...common, '--name', `${project}-meter`, '--network=none', '--read-only', '--cpus=0.1', '--memory=64m', '--memory-swap=64m', '--volume', `${project}_assets:/owned:ro`, '--volume', `${project}_pgdata:/database:ro`, NODE_IMAGE, 'sleep', 'infinity'],
    database: [...common, '--name', `${project}-db`, '--network', `${project}_default`, '--network-alias=db', '--cpus=1', '--memory=512m', '--memory-swap=512m', '--env-file', linuxEnvironmentFile(scratch), '--volume', `${project}_pgdata:/var/lib/postgresql`, '--health-cmd=pg_isready -U postgres -d postgres', '--health-interval=2s', '--health-timeout=2s', '--health-retries=30', DATABASE_IMAGE],
  }
}

export interface BudgetSample {
  scratch: number
  workspace: number
  writable: number
  database: number
  image: number
  available: number
}
export function budgetProblem(sample: BudgetSample): string | undefined {
  if ([sample.scratch, sample.workspace, sample.writable, sample.database, sample.image, sample.available].some(value => !Number.isSafeInteger(value) || value < 0))
    return 'measurement-invalid'
  if (sample.available < 12 * GIB)
    return 'disk-reserve'
  if (sample.scratch + sample.workspace + sample.writable + sample.database + sample.image >= 16 * GIB)
    return 'environment-budget'
  return undefined
}

export interface LinuxSteps {
  body: () => Promise<number>
  quiesce: () => Promise<boolean>
  close: () => Promise<boolean>
  collect: () => Promise<{ safeToRelease: boolean, passed: boolean }>
  release: (closed: boolean) => Promise<boolean>
}
export function guestExitStatus(client: number, guest: { running: boolean, exit: number, oom: boolean }): number {
  return client !== 0 ? client : guest.running || guest.exit !== 0 || guest.oom ? 1 : 0
}
export async function withLinuxCleanup(steps: LinuxSteps) {
  let status = 1
  let closed = false
  let cacheHandled = false
  const errors: string[] = []
  try {
    status = await steps.body()
  }
  catch {
    errors.push('execution-failed')
  }
  let quiescent = false
  try {
    quiescent = await steps.quiesce()
  }
  catch {
    errors.push('container-quiesce-error')
  }
  if (!quiescent) {
    errors.push('container-not-quiescent')
  }
  else {
    let safe = false
    try {
      const evidence = await steps.collect()
      safe = evidence.safeToRelease
      if (!evidence.passed)
        errors.push('evidence-not-passed')
    }
    catch {
      errors.push('evidence-rejected')
    }
    if (safe) {
      try {
        closed = await steps.close()
      }
      catch {
        errors.push('container-close-error')
      }
    }
  }
  if (!closed)
    errors.push('container-not-closed')
  try {
    cacheHandled = await steps.release(closed)
  }
  catch {
    errors.push('image-release-error')
  }
  if (!cacheHandled)
    errors.push('image-not-handled')
  return { status: status === 0 && errors.length > 0 ? 1 : status, errors, closed, cacheHandled }
}

/** A failed sample must not leave the read-only meter alive. */
export async function stopWithMeter(steps: { writers: readonly (() => void)[], measure: () => Promise<void>, meter: () => void }): Promise<void> {
  try {
    let failed = false
    for (const stop of steps.writers) {
      try {
        stop()
      }
      catch {
        failed = true
      }
    }
    if (failed)
      throw new Error('linux-writers-not-stopped')
    await steps.measure()
  }
  finally {
    steps.meter()
  }
}
