import { describe, expect, it } from 'vitest'
import { checkContainerImages, imageReferences } from './container-images.ts'

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const POLICY = { nodeVersion: '24.21.0', pnpmVersion: '12.6.0' }

/** 与 deploy/Dockerfile 同样的写法：Node 镜像经 ARG 给出，阶段之间互相引用 */
const DOCKERFILE = `ARG NODE_IMAGE=node:24.21.0-bookworm-slim@${DIGEST_A}
FROM \${NODE_IMAGE} AS base
RUN npm install --global pnpm@12.6.0
FROM base AS manifests
FROM base AS build
COPY --from=manifests /app /app
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \\
    pnpm install --frozen-lockfile
FROM build AS runtime
COPY --from=build /app/dist /app/dist
`

function rules(files: { path: string, content: string }[]): string[] {
  return checkContainerImages(files, POLICY).map(v => v.rule)
}

describe('US-M1-11 A01 容器镜像按摘要锁定（P5 设计 §3.2）', () => {
  it('镜像引用：Dockerfile 的 FROM（按 ARG 的默认值展开，跳过前面定义的阶段），YAML 的 image:', () => {
    expect(imageReferences({ path: 'deploy/Dockerfile', content: `${DOCKERFILE}FROM caddy:2.11.4-alpine@${DIGEST_B}\n` }))
      .toEqual([
        { path: 'deploy/Dockerfile', line: 2, reference: `node:24.21.0-bookworm-slim@${DIGEST_A}` },
        { path: 'deploy/Dockerfile', line: 11, reference: `caddy:2.11.4-alpine@${DIGEST_B}` },
      ])
    expect(imageReferences({ path: 'deploy/test/compose.yaml', content: `services:\n  db:\n    image: 'postgres:18.6-alpine@${DIGEST_B}' # 注释\n` }).map(r => r.reference))
      .toEqual([`postgres:18.6-alpine@${DIGEST_B}`])
  })

  it('整个引用是变量的（本仓库构建、运行时指定的镜像）不算；只有标签是变量的照常检查', () => {
    const content = `  app:\n    image: \${NERVE_IMAGE:?缺少 NERVE_IMAGE}\n  db:\n    image: postgres:\${PG_TAG}\n`
    expect(imageReferences({ path: 'deploy/test/compose.yaml', content }).map(r => r.reference)).toEqual([`postgres:\${PG_TAG}`])
    expect(rules([{ path: 'deploy/test/compose.yaml', content }])).toEqual(['pins/image-variable'])
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
    ['Node 的版本与 .node-version 不一致', 'deploy/Dockerfile', `ARG NODE_IMAGE=node:24.20.0-bookworm-slim@${DIGEST_A}\nFROM \${NODE_IMAGE}\n`, 'pins/node-image'],
    ['pnpm 的版本与 packageManager 不一致', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN npm install --global pnpm@12.5.0\n`, 'pins/pnpm-image'],
    // 审查 A5：下面这几种写法原来都拦不住
    ['ARG 的名字里没有 IMAGE：FROM 按默认值展开', 'deploy/Dockerfile', `ARG BASE=node:22-slim\nFROM \${BASE}\n`, 'pins/image-digest'],
    ['FROM 的变量没有默认值', 'deploy/Dockerfile', `ARG BASE\nFROM \${BASE}\n`, 'pins/image-variable'],
    ['全局安装 pnpm 没写版本', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN npm install --global pnpm\n`, 'pins/pnpm-image'],
    ['全局安装 pnpm 没写版本（续行）', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN npm i -g \\\n    pnpm && pnpm -v\n`, 'pins/pnpm-image'],
    ['COPY --from 引用外部镜像', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nCOPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy\n`, 'pins/image-digest'],
    ['RUN --mount 引用外部镜像', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN --mount=type=bind,from=busybox:1,source=/bin,target=/b ls /b\n`, 'pins/image-digest'],
    ['工作流的 container: 简写', '.github/workflows/ci.yml', '    container: node:24\n', 'pins/image-digest'],
    ['工作流的 uses: docker://', '.github/workflows/ci.yml', '      - uses: docker://alpine:3\n', 'pins/image-digest'],
    ['YAML 里只有标签是变量', 'deploy/test/compose.yaml', `    image: postgres:\${PG_TAG}\n`, 'pins/image-variable'],
  ])('违规：%s', (_case, path, content, rule) => {
    expect(rules([{ path, content }])).toContain(rule)
  })

  it('不算违规：前面定义的阶段、按序号引用的阶段、scratch、全局安装 pnpm 写明了版本、npm 安装名字以 pnpm 开头的别的包', () => {
    expect(rules([{
      path: 'deploy/Dockerfile',
      content: `${DOCKERFILE}COPY --from=0 /a /a\nFROM scratch AS empty\nRUN npm install --global pnpm@12.6.0 && npm install -g pnpm-lock-helper\n`,
    }])).toEqual([])
  })

  it('违规：同一个镜像在各处引用得不一样', () => {
    expect(rules([
      { path: 'deploy/dev/compose.yaml', content: `    image: postgres:18.6-alpine@${DIGEST_A}\n` },
      { path: 'deploy/test/compose.yaml', content: `    image: postgres:18.6-alpine@${DIGEST_B}\n` },
    ])).toEqual(['pins/image-consistency'])
  })
})
