FROM node:24.22.1-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm prune --prod

FROM base AS final
ENV NODE_ENV=production
# There is intentionally no config/production.yaml: instance settings live in
# config/local.yml, mounted at runtime. Suppress node-config's strictness warning.
ENV SUPPRESS_STRICTNESS_CHECK=true
WORKDIR /usr/src/app
COPY --from=build --chown=node:node /usr/src/app/dist ./dist
COPY --from=build --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/package.json ./package.json
COPY --from=build --chown=node:node /usr/src/app/config ./config
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const config=require('config');fetch('http://127.0.0.1:'+config.get('server.port')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD [ "node", "dist/index.js" ]
