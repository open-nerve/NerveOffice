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

  it.each([
    // 复验 RA2：下面这几种写法第一轮修复之后仍然漏掉或者误报
    ['续行中间夹着注释行与空行，没写版本的 pnpm 照样拦下', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\nRUN npm i -g \\\n# 注释\n\n    pnpm\n`, 'pins/pnpm-image'],
    ['compose 的变量带默认值：检查默认值', 'deploy/test/compose.yaml', `    image: \${X:-postgres:18}\n`, 'pins/image-digest'],
    ['工作流的 container: 用表达式给出', '.github/workflows/ci.yml', `    container: \${{ matrix.image }}\n`, 'pins/image-variable'],
    ['工作流的 image: 用表达式给出', '.github/workflows/ci.yml', `        image: \${{ matrix.image }}\n`, 'pins/image-variable'],
    ['一行声明几个 ARG：第二个照样展开', 'deploy/Dockerfile', `ARG A=1 BASE=node:22-slim\nFROM \${BASE}\n`, 'pins/image-digest'],
    ['FROM 用的是阶段里声明的 ARG（Docker 只认全局的）', 'deploy/Dockerfile', `FROM node:24.21.0-bookworm-slim@${DIGEST_A} AS base\nARG BASE=node:22-slim\nFROM \${BASE}\n`, 'pins/image-variable'],
  ])('违规（续）：%s', (_case, path, content, rule) => {
    expect(rules([{ path, content }])).toContain(rule)
  })

  it.each([
    // 复验 SA1、SA2
    ['以反斜杠结尾的注释不续行：下一行的 FROM 照样检查', 'deploy/Dockerfile', `# 说明 \\\nFROM node:22-slim\n`, 'pins/image-digest'],
    ['以变量开头、只有一部分是变量的引用', 'deploy/test/compose.yaml', `    image: \${REGISTRY}/postgres:18\n`, 'pins/image-variable'],
  ])('违规（再续）：%s', (_case, path, content, rule) => {
    expect(rules([{ path, content }])).toContain(rule)
  })

  it('不算违规：注释里写着 npm i -g pnpm；整个值是带说明的必填变量（复验 SA1、SA2）', () => {
    expect(rules([{ path: 'deploy/Dockerfile', content: `FROM node:24.21.0-bookworm-slim@${DIGEST_A}\n# 以前是 npm i -g pnpm\n` }])).toEqual([])
    expect(imageReferences({ path: 'deploy/test/compose.yaml', content: `    image: \${NERVE_IMAGE:?缺少 NERVE_IMAGE（用 deploy/Dockerfile 构建的镜像）}\n` })).toEqual([])
  })

  it('不算违规：RUN 的命令本身的参数里有 --from=；阶段里不带默认值的 ARG 沿用全局的默认值（复验 RA2）', () => {
    expect(rules([{
      path: 'deploy/Dockerfile',
      content: `ARG NODE_IMAGE=node:24.21.0-bookworm-slim@${DIGEST_A}\nFROM \${NODE_IMAGE} AS base\nRUN tool --from=2024-01-01 && echo --from=x\nFROM base AS copy\nARG NODE_IMAGE\nCOPY --from=\${NODE_IMAGE} /usr/local/bin/node /node\n`,
    }])).toEqual([])
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
