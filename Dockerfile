# ReadyFor core service and iMessage adapter (one image, two processes).
#   core:     docker run --env-file .env -p 8787:8787 readyfor
#   adapter:  docker run --env-file .env readyfor bun imessage/src/main.ts
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json neon.ts ./
COPY core core
COPY imessage imessage
COPY db db
ENV NODE_ENV=production CORE_PORT=8787 AUTH_REQUIRED=1
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.CORE_PORT||8787)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER bun
CMD ["bun", "core/src/main.ts"]
