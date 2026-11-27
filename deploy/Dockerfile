# Agentropy runtime host image (FEAT-028.8). Build from the repository root:
#   docker build -f deploy/Dockerfile -t agentropy-host:0.0.0 .
# The base image is pinned by digest (TASK-030.1); Dependabot proposes digest updates.
FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9 AS build
WORKDIR /src
# Node 25+ images no longer bundle a pnpm launcher: install the pnpm that package.json pins (check-deploy compares, TASK-041).
RUN npm install --global pnpm@10.34.9
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @agentropy/examples deploy --prod --legacy /out

FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9
WORKDIR /app
# Group 0 ownership and group write let OpenShift's arbitrary UIDs (restricted-v2 SCC) use /data.
COPY --from=build --chown=1001:0 /out /app
RUN mkdir -p /data && chown 1001:0 /data && chmod 0775 /data
USER 1001
ENV NODE_ENV=production \
    AGENTROPY_DB=/data/agentropy.db \
    PORT=8080
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "dist/host.js"]
