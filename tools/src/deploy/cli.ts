// 部署相关的命令（P5 设计 §3.1）：node tools/src/deploy/cli.ts <命令> [参数]
// - server-licenses --out <文件>：按 api 的生产依赖图生成服务端的第三方许可清单（镜像构建时执行）
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { collectInstalled } from '../gates/dependency-graph.ts'
import { lsOutputSchema } from '../gates/pnpm-outputs.ts'
import { commandJson } from '../shared/repo.ts'
import { API_PACKAGE, missingTexts, renderServerLicenses, SERVER_LICENSE_SUPPLEMENT, serverPackages } from './server-licenses.ts'

function usage(): never {
  console.error('用法：node tools/src/deploy/cli.ts server-licenses --out <文件>')
  process.exit(2)
}

function serverLicenses(args: readonly string[]): void {
  const outIndex = args.indexOf('--out')
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined
  if (out === undefined || args.length !== 2)
    usage()
  const graph = collectInstalled(lsOutputSchema.parse(commandJson('pnpm', ['ls', '--prod', '--json', '--depth', 'Infinity', '--filter', API_PACKAGE])))
  if (graph.unexpanded.length > 0) {
    console.error(`生产依赖图不完整，这些实例没有展开：${graph.unexpanded.join('、')}`)
    process.exit(1)
  }
  const { packages, notInstalled } = serverPackages(graph, SERVER_LICENSE_SUPPLEMENT)
  const missing = missingTexts(packages)
  if (missing.length > 0) {
    console.error(`这些包没有许可正文：${missing.join('、')}。把正文补进 apps/api/third-party-licenses/<包名>/LICENSE`)
    process.exit(1)
  }
  const target = resolve(out)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderServerLicenses(packages))
  console.log(`服务端的第三方许可清单：${packages.length} 个包（本平台没有安装的平台专属包 ${notInstalled} 个不列），写在 ${target}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'server-licenses')
  serverLicenses(rest)
else
  usage()
