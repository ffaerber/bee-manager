# Build the dashboard, then run it and the daemon from one Bun image.
FROM oven/bun:1.2-alpine AS web
WORKDIR /app/web
COPY web/package.json ./
RUN bun install
COPY web/ ./
RUN bun run build

FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY src/ ./src/
COPY --from=web /app/web/dist ./web/dist
# Stamped by CI so a running container can say which build it is. Without
# this the only way to tell a stale deploy from a current one was to diff the
# hashed asset filename against a fresh build, which is not something anyone
# does before trusting a dashboard.
ARG BUILD_SHA=dev
ARG BUILD_TIME=
ENV BUILD_SHA=$BUILD_SHA BUILD_TIME=$BUILD_TIME
# SQLite lives on a volume; the image itself stays stateless.
ENV DB_PATH=/data/monitor.sqlite
VOLUME /data
EXPOSE 3000
CMD ["bun", "src/index.ts"]
