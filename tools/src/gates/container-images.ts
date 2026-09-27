// A01：容器镜像同样精确锁定（P5 设计 §3.2）。Dockerfile、编排文件与 CI 工作流里引用的镜像一律带摘要；
// Dockerfile 的 Node 镜像与 .node-version 同一个版本，全局安装的 pnpm 写明版本、与 packageManager 同一个版本；
// 同一个镜像在各处（开发库、测试环境、CI 的服务容器）引用得完全一样。
// 引用的来源：Dockerfile 的 FROM（变量按前面 ARG 的默认值展开）、COPY/ADD 的 --from 与 RUN --mount 的 from（前面定义的阶段除外），
// YAML 的 image:、工作流的 container: 简写与 uses: docker://。
import type { Violation } from './types.ts'

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
const DOCKERFILE_ARG = /^\s*ARG\s+(\w+)(?:=(\S*))?/i
const DOCKERFILE_FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i
/** COPY、ADD 的 --from=，RUN 的 --mount=…,from= */
const FROM_OPTION = /--from=([^\s,]+)|--mount=\S*?\bfrom=([^\s,]+)/gi
const VARIABLE = /\$\{(\w+)\}|\$(\w+)/g
const YAML_IMAGE = /^\s*(?:-\s*)?image:\s*['"]?([^'"\s#]+)/
/** 工作流的 container: 简写（值直接是镜像）；写成映射时由 image: 覆盖 */
const WORKFLOW_CONTAINER = /^\s*container:\s*['"]?([^'"\s#{]+)/
const WORKFLOW_DOCKER_ACTION = /^\s*(?:-\s*)?uses:\s*['"]?docker:\/\/([^'"\s#]+)/
const PNPM_VERSION = /\bpnpm@(\S+)/g
/** npm 全局安装 pnpm 却没写版本：`npm install -g pnpm`、`npm i --global pnpm`（后面不是 @） */
const PNPM_WITHOUT_VERSION = /\bnpm\s+(?:install|i|add)\b[^;&|]*?\spnpm(?![@\w-])/

function isDockerfile(path: string): boolean {
  return /(?:^|\/)Dockerfile(?:\.[\w-]+)?$/.test(path)
}

/** Dockerfile 的指令：行尾的反斜杠续行拼成一条，行号取第一行 */
function instructions(content: string): { line: number, text: string }[] {
  const result: { line: number, text: string }[] = []
  let pending: { line: number, text: string } | undefined
  content.split('\n').forEach((text, index) => {
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

function dockerfileReferences(file: TextFile): ImageReference[] {
  const references: ImageReference[] = []
  const args = new Map<string, string>()
  const stages = new Set<string>()
  const external = (reference: string): boolean => !stages.has(reference.toLowerCase()) && !/^\d+$/.test(reference)
  for (const { line, text } of instructions(file.content)) {
    const arg = DOCKERFILE_ARG.exec(text)
    if (arg?.[1] !== undefined) {
      if (arg[2] !== undefined)
        args.set(arg[1], unquote(arg[2]))
      continue
    }
    const from = DOCKERFILE_FROM.exec(text)
    if (from?.[1] !== undefined) {
      const reference = expand(from[1], args)
      if (external(reference) && reference.toLowerCase() !== 'scratch')
        references.push({ path: file.path, line, reference })
      if (from[2] !== undefined)
        stages.add(from[2].toLowerCase())
      continue
    }
    if (!/^\s*(?:COPY|ADD|RUN)\b/i.test(text))
      continue
    for (const option of text.matchAll(FROM_OPTION)) {
      const reference = expand(option[1] ?? option[2] ?? '', args)
      if (external(reference))
        references.push({ path: file.path, line, reference })
    }
  }
  return references
}

function yamlReferences(file: TextFile): ImageReference[] {
  const references: ImageReference[] = []
  file.content.split('\n').forEach((text, index) => {
    const reference = YAML_IMAGE.exec(text)?.[1] ?? WORKFLOW_CONTAINER.exec(text)?.[1] ?? WORKFLOW_DOCKER_ACTION.exec(text)?.[1]
    if (reference !== undefined && !reference.startsWith('$'))
      references.push({ path: file.path, line: index + 1, reference })
  })
  return references
}

/**
 * 文件里引用的镜像（见文件开头）。YAML 里整个引用是变量的（例如测试环境的 image: ${NERVE_IMAGE}）不算：
 * 那是用本仓库的 Dockerfile 构建、运行时指定的镜像；其余带变量的引用（postgres:${TAG}、没有默认值的 FROM ${BASE}）锁不住，按违规处理。
 */
export function imageReferences(file: TextFile): ImageReference[] {
  return isDockerfile(file.path) ? dockerfileReferences(file) : yamlReferences(file)
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
  const violations: Violation[] = []
  const references = files.flatMap(imageReferences)
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
    for (const match of file.content.matchAll(PNPM_VERSION)) {
      if (match[1] !== policy.pnpmVersion)
        violations.push({ rule: 'pins/pnpm-image', subject: `${file.path} pnpm@${match[1] ?? ''}`, detail: `镜像里的 pnpm 必须与 packageManager（${policy.pnpmVersion}）一致` })
    }
    for (const { line, text } of instructions(file.content)) {
      if (PNPM_WITHOUT_VERSION.test(text))
        violations.push({ rule: 'pins/pnpm-image', subject: `${file.path}:${line}`, detail: `全局安装 pnpm 要写明版本（pnpm@${policy.pnpmVersion}），否则装的是构建当时的最新版` })
    }
  }
  return violations
}
