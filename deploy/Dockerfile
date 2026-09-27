# NerveOffice 的镜像（P5 设计 §3.2，ADR-012）：一个应用容器同时托管前端与 API。
# 在仓库根目录构建：docker build -f deploy/Dockerfile -t nerve-office:<版本> .
# 不绑定平台：CI 构建 linux/amd64，本机（Apple 芯片）构建 linux/arm64；基础镜像按多架构索引的摘要锁定。
# 阶段：base（加上 pnpm）→ build（全部依赖、构建、服务端许可清单）→ prod-deps（只装 api 的生产依赖）→ runtime（不带 pnpm、npm 与源码）。

# Node 的版本与 .node-version 一致，pnpm 的版本与根目录 package.json 的 packageManager 一致（门禁 pins 核对）
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE} AS base
# pnpm 12 用 npm 全局安装，corepack 运行不了它（ADR-002）。要执行 pnpm 自己的安装脚本：它把本平台的原生二进制放到位，
# 否则留下的是没有 shebang 的占位文件，只有经过 shell 才能运行；工作区开了 shellEmulator，脚本里的 pnpm 由它直接启动，会得到 Exec format error
RUN npm install --global pnpm@12.6.0
WORKDIR /app

# 只复制锁文件、工作区配置与各包的 package.json：依赖层只在它们变化时重建
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY tools/package.json tools/
COPY tests/e2e/package.json tests/e2e/
COPY tests/integration/package.json tests/integration/

FROM manifests AS build
# 安装脚本在 allowBuilds 里都不执行；prepare 装 git 钩子，镜像里没有 .git，也不需要
RUN --mount=type=cache,id=nerve-office-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
COPY apps/web apps/web
COPY tools tools
# contracts、api 与 web 的生产构建（web 不是 dist-e2e：测试构建里的 CSP 探针不能进镜像）
RUN pnpm run build
# 服务端的第三方许可清单：按 api 的生产依赖图，本平台装上的包（P5 设计 §3.2.1）
RUN node tools/src/deploy/cli.ts server-licenses --out /app/licenses/THIRD-PARTY-LICENSES-server.md

# 只装 api 与它依赖的工作区包（contracts）的生产依赖，保持 pnpm 的软链接结构
FROM manifests AS prod-deps
RUN --mount=type=cache,id=nerve-office-pnpm-store,target=/pnpm-store \
    pnpm install --prod --frozen-lockfile --ignore-scripts --store-dir /pnpm-store --filter @nerve-office/api...

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.1.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="NerveOffice" \
      org.opencontainers.image.source="https://github.com/open-nerve/NerveOffice" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# 运行时用不到 npm、npx、corepack 与 yarn：去掉，减少体积与攻击面
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# 应用不读 NODE_ENV，Express 的默认行为按生产；前端的生产构建放在 /app/web
ENV NODE_ENV=production \
    NERVE_WEB_ROOT=/app/web
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules packages/contracts/node_modules
# package.json 里的 "type": "module" 决定 dist 按 ESM 加载；api 的 dist 里带着迁移目录（dist/db/migrations）
COPY --from=build /app/packages/contracts/package.json packages/contracts/
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist web
COPY --from=build /app/licenses licenses
COPY LICENSE licenses/LICENSE
# 文件归 root 所有、以镜像自带的非 root 用户 node 运行：应用改不了自己的代码
WORKDIR /app/apps/api
USER node
EXPOSE 3000
# slim 镜像里没有 curl：用 Node 自带的 fetch 请求就绪探针；就绪失败按 error 记日志，间隔不宜太密
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.NERVE_HTTP_PORT || '3000') + '/api/health/ready').then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
# exec 形式：信号直达 Node。编排里另开 init（Node 的信号处理在监听成功之后才装上，作为 PID 1 在那之前收到 SIGTERM 不会退出）
CMD ["node", "dist/app/main.js"]
