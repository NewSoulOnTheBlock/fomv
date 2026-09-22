# FOMV follow server.
#
# A long-running stateful process, not a serverless function: it holds a
# per-subscriber cursor, a SQLite file and rate-limited RPC connections. Run
# exactly one instance against a given database -- two would read the same
# unprocessed trades before either recorded a fill, and mirror everything twice.
FROM oven/bun:1.3-alpine

WORKDIR /app

# Dependencies first so a source change does not re-resolve the lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

# SQLite lives here. Mount a volume or the state is lost on redeploy, and a
# fresh cursor means the next cycle re-reads history it has already acted on.
RUN mkdir -p /app/state
VOLUME ["/app/state"]

ENV FOMV_DB_PATH=/app/state/follow.sqlite
ENV PORT=8080
EXPOSE 8080

# Dry-run unless explicitly overridden. A server that signed real transactions
# the moment it booted would be the wrong default however careful the operator.
ENV MODE=dry-run

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["bun", "run", "src/server/index.ts"]
