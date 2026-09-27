import { describe, expect, it } from 'vitest'
import { checkContainerImages, imageReferences } from './container-images.ts'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const POLICY = { nodeVersion: '24.21.0', pnpmVersion: '12.6.0' }

const DOCKERFILE = `ARG NODE_IMAGE=node:24.21.0-bookworm-slim@${DIGEST_A}
FROM \${NODE_IMAGE} AS base
RUN npm install --global --ignore-scripts pnpm@12.6.0
FROM base AS build
FROM build AS runtime
`

function rules(files: { path: string, content: string }[]): string[] {
  return checkContainerImages(files, POLICY).map(v => v.rule)
}

describe('US-M1-11 A01 容器镜像按摘要锁定（P5 设计 §3.2）', () => {
  it('镜像引用：Dockerfile 的 ARG …IMAGE= 与 FROM（跳过变量与前面定义的阶段），YAML 的 image:', () => {
    expect(imageReferences({ path: 'deploy/Dockerfile', content: `${DOCKERFILE}FROM caddy:2.11.4-alpine@${DIGEST_B}\n` }).map(r => r.reference))
      .toEqual([`node:24.21.0-bookworm-slim@${DIGEST_A}`, `caddy:2.11.4-alpine@${DIGEST_B}`])
    expect(imageReferences({ path: 'deploy/test/compose.yaml', content: `services:\n  db:\n    image: 'postgres:18.6-alpine@${DIGEST_B}' # 注释\n` }).map(r => r.reference))
      .toEqual([`postgres:18.6-alpine@${DIGEST_B}`])
  })

  it('合规：按摘要锁定、Node 与 pnpm 的版本一致、同一个镜像各处一样', () => {
    expect(rules([
      { path: 'deploy/Dockerfile', content: DOCKERFILE },
      { path: 'deploy/dev/compose.yaml', content: `    image: postgres:18.6-alpine@${DIGEST_B}\n` },
      { path: '.github/workflows/ci.yml', content: `        image: postgres:18.6-alpine@${DIGEST_B}\n` },
    ])).toEqual([])
  })

  it.each([
    ['只有标签', 'deploy/test/compose.yaml', '    image: caddy:2.11.4-alpine\n', 'pins/image-digest'],
    ['Node 的版本与 .node-version 不一致', 'deploy/Dockerfile', `ARG NODE_IMAGE=node:24.20.0-bookworm-slim@${DIGEST_A}\n`, 'pins/node-image'],
    ['pnpm 的版本与 packageManager 不一致', 'deploy/Dockerfile', `ARG NODE_IMAGE=node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN npm install --global pnpm@12.5.0\n`, 'pins/pnpm-image'],
  ])('违规：%s', (_case, path, content, rule) => {
    expect(rules([{ path, content }])).toContain(rule)
  })

  it('违规：同一个镜像在各处引用得不一样', () => {
    expect(rules([
      { path: 'deploy/dev/compose.yaml', content: `    image: postgres:18.6-alpine@${DIGEST_A}\n` },
      { path: 'deploy/test/compose.yaml', content: `    image: postgres:18.6-alpine@${DIGEST_B}\n` },
    ])).toEqual(['pins/image-consistency'])
  })
})
