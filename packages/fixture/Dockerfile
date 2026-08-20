# syntax=docker/dockerfile:1

# Deployz fixture application — a minimal Node.js/Express app with a
# /health endpoint and a PostgreSQL connection, deployed by the integration
# suite to prove the INSTALL flow reaches HEALTHY.
#
# Build from the repository root:
#   docker build -f packages/fixture/Dockerfile -t deployz-fixture .

# ── Stage 1: compile TypeScript ──────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/fixture/package.json ./packages/fixture/package.json
COPY packages/fixture/tsconfig.json ./packages/fixture/tsconfig.json
COPY packages/fixture/src ./packages/fixture/src
WORKDIR /app/packages/fixture
RUN npm install && npm run build

# ── Stage 2: production runtime ──────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /app/packages/fixture/dist ./dist
COPY --from=build /app/packages/fixture/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]