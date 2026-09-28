// A01：容器镜像同样精确锁定（P5 设计 §3.2）。Dockerfile、编排文件与 CI 工作流里引用的镜像一律带摘要；
// Dockerfile 的 Node 镜像与 .node-version 同一个版本，全局安装的 pnpm 写明版本、与 packageManager 同一个版本；
// 同一个镜像在各处（开发库、测试环境、CI 的服务容器）引用得完全一样。
// 引用的来源：Dockerfile 的 FROM（变量按前面 ARG 的默认值展开）、COPY/ADD 的 --from 与 RUN --mount 的 from（前面定义的阶段除外），
// YAML 里任何层级的 image:、工作流的 jobs.<id>.container 简写与 uses: docker://。
// YAML 按语法解析，不按行匹配：flow 写法（{ image: postgres:18 }）、带引号的键、锚点与别名都认得出；
// 解析不了的文件报违规，不当作没有引用（Codex 评审 CX8）。
import type { Document } from 'yaml'
import type { Violation } from './types.ts'
import { isAlias, isMap, isNode, isScalar, LineCounter, parseAllDocuments, visit } from 'yaml'

export interface TextFile {
  readonly path: string
  readonly content: string
}

export interface ImagePolicy {
  /** .node-version 的版本，例如 24.21.0 */
  readonly nodeVersion: string
  /** packageManager 里 pnpm 的版本，例如 12.6.0 */
  readonly pnpmVersion: string
}

export interface ImageReference {
  readonly path: string
  readonly line: number
  readonly reference: string
}

const DIGEST = /@sha256:[0-9a-f]{64}$/
const DOCKERFILE_ARG = /^\s*ARG\s(.*)$/i
const DOCKERFILE_FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i
/** COPY、ADD、RUN 的选项部分（指令之后、以 -- 开头的那几项）：--from 与 --mount 的 from 只在这里找（复验 RA2） */
const INSTRUCTION_OPTIONS = /^\s*(?:COPY|ADD|RUN)\s+((?:--\S+\s+)*)/i
const VARIABLE = /\$\{(\w+)\}|\$(\w+)/g
/**
 * exec 形式（JSON 数组）的命令：RUN、CMD、ENTRYPOINT（可以在 ONBUILD 之后），指令与选项之后整段是 JSON 数组。
 * 先解析成字符串数组、按空格拼起来再检查：否则 RUN ["npm", "install", "--global", "pnpm"] 漏检，
 * ["npm", "i", "-g", "pnpm@12.6.0"] 又把结尾的引号与括号算进版本（Codex 评审 CX8）
 */
const EXEC_FORM = /^(\s*(?:ONBUILD\s+)?(?:RUN|CMD|ENTRYPOINT)\s+(?:--\S+\s+)*)(\[.*\])\s*$/i
/** compose 的变量带默认值：${X:-镜像}、${X-镜像}，检查默认值 */
const COMPOSE_DEFAULT = /^\$\{\w+:?-([^}]+)\}$/
/** 整个值就是一个没有默认值的 compose 变量：${X}、${X:?说明}、$X */
const WHOLE_VARIABLE = /^\$(?:\{\w+(?::?\?[^}]*)?\}|\w+)$/
/** uses: 的值以它开头时是 Docker 镜像（工作流的 docker:// 动作） */
const DOCKER_ACTION = 'docker://'
const PNPM_VERSION = /\bpnpm@(\S+)/g
/** npm 全局安装 pnpm 却没写版本：`npm install -g pnpm`、`npm i --global pnpm`（后面不是 @） */
const PNPM_WITHOUT_VERSION = /\bnpm\s+(?:install|i|add)\b[^;&|]*?\spnpm(?![@\w-])/

function isDockerfile(path: string): boolean {
  return /(?:^|\/)Dockerfile(?:\.[\w-]+)?$/.test(path)
}

/** GitHub 的工作流：jobs.<id>.container 可以直接写镜像 */
function isWorkflow(path: string): boolean {
  return /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
}

/**
 * Dockerfile 的指令：行尾的反斜杠续行拼成一条，行号取第一行。注释行不是指令：以反斜杠结尾也不续行（复验 SA1）；
 * 续行中间的注释行与空行不算（Docker 同样跳过它们，指令照样接着下一行，复验 RA2）
 */
function instructions(content: string): { line: number, text: string }[] {
  const result: { line: number, text: string }[] = []
  let pending: { line: number, text: string } | undefined
  content.split('\n').forEach((text, index) => {
    if (/^\s*#/.test(text) || (pending !== undefined && /^\s*$/.test(text)))
      return
    const joined = pending === undefined ? { line: index + 1, text } : { line: pending.line, text: `${pending.text} ${text}` }
    if (/\\\s*$/.test(text)) {
      pending = { line: joined.line, text: joined.text.replace(/\\\s*$/, '') }
      return
    }
    pending = undefined
    result.push(joined)
  })
  if (pending !== undefined)
    result.push(pending)
  return result
}

function unquote(value: string): string {
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
}

/** 按前面 ARG 的默认值展开变量；展不开的原样保留（引用里留下 $，按违规处理） */
function expand(text: string, args: ReadonlyMap<string, string>): string {
  return text.replace(VARIABLE, (whole, braced: string | undefined, bare: string | undefined) => args.get(braced ?? bare ?? '') ?? whole)
}

/** ARG 指令声明的变量（一行可以声明几个）：名字 → 默认值（没有默认值时是 undefined） */
function declaredArgs(declaration: string): [string, string | undefined][] {
  return declaration.trim().split(/\s+/).flatMap((item) => {
    const match = /^(\w+)(?:=(.*))?$/.exec(item)
    return match?.[1] === undefined ? [] : [[match[1], match[2] === undefined ? undefined : unquote(match[2])] as [string, string | undefined]]
  })
}

/**
 * FROM 只能用第一个 FROM 之前声明的全局 ARG；阶段里的 COPY、RUN 用这个阶段声明的 ARG
 * （不带默认值的声明沿用全局的默认值），与 Docker 的作用域一致（复验 RA2）
 */
function dockerfileReferences(file: TextFile): ImageReference[] {
  const references: ImageReference[] = []
  const globalArgs = new Map<string, string>()
  let stageArgs: Map<string, string> | undefined
  const stages = new Set<string>()
  const external = (reference: string): boolean => !stages.has(reference.toLowerCase()) && !/^\d+$/.test(reference)
  for (const { line, text } of instructions(file.content)) {
    const arg = DOCKERFILE_ARG.exec(text)
    if (arg?.[1] !== undefined) {
      for (const [name, value] of declaredArgs(arg[1])) {
        const inherited = value ?? globalArgs.get(name)
        const scope = stageArgs ?? globalArgs
        if (inherited !== undefined)
          scope.set(name, inherited)
      }
      continue
    }
    const from = DOCKERFILE_FROM.exec(text)
    if (from?.[1] !== undefined) {
      const reference = expand(from[1], globalArgs)
      if (external(reference) && reference.toLowerCase() !== 'scratch')
        references.push({ path: file.path, line, reference })
      if (from[2] !== undefined)
        stages.add(from[2].toLowerCase())
      stageArgs = new Map()
      continue
    }
    const options = INSTRUCTION_OPTIONS.exec(text)?.[1] ?? ''
    for (const option of options.split(/\s+/)) {
      const source = /^--from=([^\s,]+)$/i.exec(option)?.[1] ?? /^--mount=\S*?\bfrom=([^\s,]+)/i.exec(option)?.[1]
      const reference = source === undefined ? undefined : expand(source, stageArgs ?? globalArgs)
      if (reference !== undefined && external(reference))
        references.push({ path: file.path, line, reference })
    }
  }
  return references
}

/** 一个文件里的镜像引用，以及认不全引用的问题（YAML 解析失败、别名找不到锚点、镜像的值不是字符串） */
interface FileScan {
  readonly references: ImageReference[]
  readonly problems: Violation[]
}

/**
 * YAML 里的值作为镜像引用：整个是 compose 变量的（测试环境的 image: ${NERVE_IMAGE:?…}）不算：那是用本仓库的 Dockerfile 构建、
 * 运行时指定的镜像；带默认值的（${X:-postgres:18}）检查默认值；GitHub 的表达式（${{ matrix.image }}）展不开，
 * 原样交给检查，按违规处理（复验 RA2）。只有整个值就是一个没有默认值的变量才跳过；以变量开头的（${REGISTRY}/postgres:18）照常检查（复验 SA2）
 */
function yamlReference(value: string): string | undefined {
  return WHOLE_VARIABLE.test(value) ? undefined : COMPOSE_DEFAULT.exec(value)?.[1] ?? value
}

/** 工作流里 jobs.<id>.container 的值；写成映射时不算（里面的 image 由通用的遍历认出） */
function workflowContainers(document: Document, resolve: (node: unknown) => unknown): unknown[] {
  const root = resolve(document.contents)
  const jobs = isMap(root) ? resolve(root.get('jobs', true)) : undefined
  if (!isMap(jobs))
    return []
  return jobs.items.flatMap((item) => {
    const job = resolve(item.value)
    const container: unknown = isMap(job) ? job.get('container', true) : undefined
    return container === undefined || isMap(resolve(container)) ? [] : [container]
  })
}

/**
 * YAML 的镜像引用（Codex 评审 CX8）：按语法解析全部文档，引用的来源是
 * - 任何层级的映射里键 image 的值（compose 的 services.*.image、工作流的 jobs.*.container.image 与 jobs.*.services.*.image）；
 * - 工作流里 jobs.<id>.container 直接写成镜像的简写；
 * - 任何地方以 docker:// 开头的 uses:。
 * 别名展开成它的锚点；行号取值所在的行（别名取引用它的那一行）。
 * 文档解析出错时整份文档不再往下认（认出的引用不完整），报 pins/yaml-parse。
 */
function yamlScan(file: TextFile): FileScan {
  const lineCounter = new LineCounter()
  const references: ImageReference[] = []
  // 同一处的问题只报一次：别名既是 image 的值、又在别名的遍历里
  const problems = new Map<string, Violation>()
  const lineOf = (offset: number): number => lineCounter.linePos(offset).line
  const offsetOf = (node: unknown): number => (isNode(node) ? node.range?.[0] : undefined) ?? 0
  const report = (rule: string, offset: number, detail: string): void => {
    const violation = { rule, subject: `${file.path}:${lineOf(offset)}`, detail }
    problems.set(`${rule} ${violation.subject} ${detail}`, violation)
  }
  for (const document of parseAllDocuments(file.content, { lineCounter })) {
    if (document.errors.length > 0) {
      for (const error of document.errors)
        report('pins/yaml-parse', error.pos[0], `YAML 解析失败，认不全其中的镜像引用：${error.message.split('\n')[0] ?? error.code}`)
      continue
    }
    /** 值所在的节点：别名换成它的锚点；找不到锚点时报出问题（compose 与 GitHub 同样加载不了这个文件） */
    const resolve = (node: unknown): unknown => {
      if (!isAlias(node))
        return node
      const anchored = node.resolve(document)
      if (anchored === undefined)
        report('pins/yaml-parse', offsetOf(node), `别名 *${node.source} 找不到对应的锚点，认不全其中的镜像引用`)
      return anchored
    }
    const addReference = (node: unknown, value: string): void => {
      const reference = yamlReference(value)
      if (reference !== undefined)
        references.push({ path: file.path, line: lineOf(offsetOf(node)), reference })
    }
    /** image 与 container 简写的值是镜像：空值不算；不是字符串（映射、列表）时认不出引用，报出问题 */
    const noteImage = (node: unknown, key: string): void => {
      const value = resolve(node)
      if (value === undefined || value === null || (isScalar(value) && value.value === null))
        return
      if (isScalar(value))
        addReference(node, String(value.value))
      else
        report('pins/image-unrecognized', offsetOf(node), `${key} 的值不是字符串，认不出引用的镜像`)
    }
    visit(document, {
      Pair(_key, pair) {
        const key = isScalar(pair.key) ? pair.key.value : undefined
        const value = key === 'uses' ? resolve(pair.value) : undefined
        if (key === 'image')
          noteImage(pair.value, 'image')
        else if (isScalar(value) && typeof value.value === 'string' && value.value.startsWith(DOCKER_ACTION))
          addReference(pair.value, value.value.slice(DOCKER_ACTION.length))
      },
      // 其他位置上找不到锚点的别名同样报出：整个文件加载不了
      Alias(_key, alias) {
        resolve(alias)
      },
    })
    if (isWorkflow(file.path)) {
      for (const node of workflowContainers(document, resolve))
        noteImage(node, 'container')
    }
  }
  return { references, problems: [...problems.values()] }
}

function scan(file: TextFile): FileScan {
  return isDockerfile(file.path) ? { references: dockerfileReferences(file), problems: [] } : yamlScan(file)
}

/**
 * 文件里引用的镜像（见文件开头）。带着展不开的变量的引用（postgres:${TAG}、只有局部 ARG 的 FROM、GitHub 的表达式）
 * 锁不住，按违规处理；YAML 里整个是 compose 变量、没有默认值的除外（见 yamlReference）。
 */
export function imageReferences(file: TextFile): ImageReference[] {
  return scan(file).references
}

/** Dockerfile 的指令按执行的命令看：exec 形式（JSON 数组）拼成一行；不是合法的 JSON 数组时按 shell 形式原样看（Docker 也是这样） */
function commandText(instruction: string): string {
  const match = EXEC_FORM.exec(instruction)
  if (match?.[1] === undefined || match[2] === undefined)
    return instruction
  try {
    const parsed: unknown = JSON.parse(match[2])
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? `${match[1]}${parsed.join(' ')}` : instruction
  }
  catch {
    return instruction
  }
}

/** 镜像名（不含标签与摘要），例如 postgres、docker.io/library/node */
function imageName(reference: string): string {
  const withoutDigest = reference.split('@')[0] ?? reference
  const lastSlash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.indexOf(':', lastSlash + 1)
  return colon < 0 ? withoutDigest : withoutDigest.slice(0, colon)
}

/** 标签，例如 24.21.0-bookworm-slim；没有标签时是空串 */
function imageTag(reference: string): string {
  const withoutDigest = reference.split('@')[0] ?? reference
  const name = imageName(reference)
  return withoutDigest.length > name.length ? withoutDigest.slice(name.length + 1) : ''
}

export function checkContainerImages(files: readonly TextFile[], policy: ImagePolicy): Violation[] {
  const scans = files.map(scan)
  const violations: Violation[] = scans.flatMap(item => item.problems)
  const references = scans.flatMap(item => item.references)
  for (const { path, line, reference } of references) {
    const subject = `${path}:${line} ${reference}`
    if (reference.includes('$')) {
      violations.push({ rule: 'pins/image-variable', subject, detail: '镜像引用里有展不开的变量（ARG 没有默认值、YAML 里只有一部分是变量），锁不住' })
      continue
    }
    if (!DIGEST.test(reference))
      violations.push({ rule: 'pins/image-digest', subject, detail: '镜像必须按摘要锁定（<名称>:<标签>@sha256:<摘要>），标签可以被重新指向' })
    if (imageName(reference).replace(/^docker\.io\/(?:library\/)?/, '') === 'node') {
      const tag = imageTag(reference)
      if (tag !== policy.nodeVersion && !tag.startsWith(`${policy.nodeVersion}-`))
        violations.push({ rule: 'pins/node-image', subject, detail: `Node 镜像的版本必须与 .node-version（${policy.nodeVersion}）一致` })
    }
  }
  const byName = new Map<string, Set<string>>()
  for (const { reference } of references)
    byName.set(imageName(reference), new Set([...(byName.get(imageName(reference)) ?? []), reference]))
  for (const [name, variants] of byName) {
    if (variants.size > 1)
      violations.push({ rule: 'pins/image-consistency', subject: name, detail: `同一个镜像在各处引用得不一样：${[...variants].join('、')}` })
  }
  for (const file of files.filter(item => isDockerfile(item.path))) {
    for (const instruction of instructions(file.content)) {
      const { line } = instruction
      // 只在指令里找：注释里写着以前的版本不算（复验 TA2）；exec 形式先拼成命令（Codex 评审 CX8）
      const text = commandText(instruction.text)
      for (const match of text.matchAll(PNPM_VERSION)) {
        if (match[1] !== policy.pnpmVersion)
          violations.push({ rule: 'pins/pnpm-image', subject: `${file.path}:${line} pnpm@${match[1] ?? ''}`, detail: `镜像里的 pnpm 必须与 packageManager（${policy.pnpmVersion}）一致` })
      }
      if (PNPM_WITHOUT_VERSION.test(text))
        violations.push({ rule: 'pins/pnpm-image', subject: `${file.path}:${line}`, detail: `全局安装 pnpm 要写明版本（pnpm@${policy.pnpmVersion}），否则装的是构建当时的最新版` })
    }
  }
  return violations
}
