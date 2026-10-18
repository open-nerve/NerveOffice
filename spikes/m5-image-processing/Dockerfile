# Same Node baseline as deploy/Dockerfile. Build context is the recorded probe
# bundle (runtime manifests, source and generated fixtures), never the user home.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# Same pnpm bootstrap as production; pnpm 12's native launcher needs its own
# install step (ADR-002). Candidate package install scripts remain disabled.
RUN npm install --global pnpm@12.6.0
WORKDIR /runtime
COPY runtime/ ./
RUN pnpm install --frozen-lockfile --ignore-scripts && chmod 644 pnpm-lock.yaml
COPY probe/ /probe/
USER node
WORKDIR /probe
ENTRYPOINT ["node", "run.mjs", "/runtime"]
