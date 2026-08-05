# Next.js frontend. Runs the production build, not `next dev`.
FROM oven/bun:1.3.14-slim

WORKDIR /app

COPY package.json bun.lock ./
COPY shared/package.json   shared/
COPY storage/package.json  storage/
COPY backend/package.json  backend/
COPY frontend/package.json frontend/
COPY e2e/package.json      e2e/
RUN bun install --frozen-lockfile

COPY shared/   shared/
COPY storage/  storage/
COPY frontend/ frontend/

# BLOB_READ_WRITE_TOKEN is injected at runtime, not baked in. The build only
# needs to typecheck and compile.
RUN cd frontend && bun run build

EXPOSE 3000
CMD ["bun", "run", "--cwd", "frontend", "start"]
