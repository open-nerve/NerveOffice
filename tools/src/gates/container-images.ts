// A01：容器镜像同样精确锁定（P5 设计 §3.2）。Dockerfile、编排文件与 CI 工作流里引用的镜像一律带摘要；
// Dockerfile 的 Node 镜像与 .node-version 同一个版本，全局安装的 pnpm 与 packageManager 同一个版本；
// 同一个镜像在各处（开发库、测试环境、CI 的服务容器）引用得完全一样。
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
const DOCKERFILE_FROM = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i
const DOCKERFILE_IMAGE_ARG = /^\s*ARG\s+\w*IMAGE\w*=(\S+)/i
const YAML_IMAGE = /^\s*image:\s*['"]?([^'"\s#]+)/
const PNPM_INSTALL = /\bpnpm@(\S+)/g

function isDockerfile(path: string): boolean {
  return /(?:^|\/)Dockerfile(?:\.[\w-]+)?$/.test(path)
}

/**
 * 文件里引用的镜像：Dockerfile 的 FROM（不含变量与前面定义的阶段）与 ARG …IMAGE=，YAML 的 image:。
 * 整个引用是变量的（例如测试环境的 image: ${NERVE_IMAGE}）不算：那是用本仓库的 Dockerfile 构建、运行时指定的镜像；
 * 只有标签是变量的（postgres:${TAG}）照常检查，没有摘要就不通过。
 */
export function imageReferences(file: TextFile): ImageReference[] {
  const references: ImageReference[] = []
  const stages = new Set<string>()
  file.content.split('\n').forEach((text, index) => {
    const line = index + 1
    if (isDockerfile(file.path)) {
      const from = DOCKERFILE_FROM.exec(text)
      if (from?.[1] !== undefined) {
        const alias = /\bAS\s+(\S+)/i.exec(text)?.[1]
        if (alias !== undefined)
          stages.add(alias.toLowerCase())
        if (!from[1].includes('$') && !stages.has(from[1].toLowerCase()))
          references.push({ path: file.path, line, reference: from[1] })
        return
      }
      const arg = DOCKERFILE_IMAGE_ARG.exec(text)
      if (arg?.[1] !== undefined)
        references.push({ path: file.path, line, reference: arg[1] })
      return
    }
    const image = YAML_IMAGE.exec(text)
    if (image?.[1] !== undefined && !image[1].startsWith('$'))
      references.push({ path: file.path, line, reference: image[1] })
  })
  return references
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
    for (const match of file.content.matchAll(PNPM_INSTALL)) {
      if (match[1] !== policy.pnpmVersion)
        violations.push({ rule: 'pins/pnpm-image', subject: `${file.path} pnpm@${match[1] ?? ''}`, detail: `镜像里的 pnpm 必须与 packageManager（${policy.pnpmVersion}）一致` })
    }
  }
  return violations
}
