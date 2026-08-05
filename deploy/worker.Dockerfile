# Temporal worker. Bun for the workspace install, Node to run the built bundle.
FROM oven/bun:1.3.14-slim

WORKDIR /app

# Manifests first so a source-only change does not reinvalidate the install.
COPY package.json bun.lock ./
COPY shared/package.json   shared/
COPY storage/package.json  storage/
COPY backend/package.json  backend/
COPY frontend/package.json frontend/
COPY e2e/package.json      e2e/
RUN bun install --frozen-lockfile

COPY shared/  shared/
COPY storage/ storage/
COPY backend/ backend/
RUN bun run --filter @wf/backend build

# qpdf gives pdf.compress a working engine. LibreOffice is deliberately left
# out: it is ~700MB and would dominate the image for two tools that report
# themselves unavailable cleanly without it.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends qpdf \
 && rm -rf /var/lib/apt/lists/*

CMD ["bun", "backend/dist/main.js"]
