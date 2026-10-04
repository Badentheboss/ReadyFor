# ReadyFor coordinator dashboard. Build from the repository root:
#   docker build -f dashboard/Dockerfile -t readyfor-dashboard .
FROM oven/bun:1
WORKDIR /app
COPY dashboard/package.json dashboard/bun.lock dashboard/
RUN cd dashboard && bun install --frozen-lockfile --production
COPY dashboard dashboard
COPY db/seed db/seed
ENV NODE_ENV=production DASHBOARD_PORT=4173
EXPOSE 4173
USER bun
CMD ["bun", "dashboard/server.ts"]
