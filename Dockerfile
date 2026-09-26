# ---- 1. Install dependencies once (cached until a package.json changes) ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/ingest/package.json apps/ingest/
COPY apps/relay/package.json apps/relay/
COPY apps/worker/package.json apps/worker/
COPY apps/gateway/package.json apps/gateway/
COPY apps/mock-target/package.json apps/mock-target/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --no-audit --no-fund

# ---- 2. Build the dashboard into static files ----
FROM deps AS dashboard-build
COPY . .
RUN npm run build -w apps/dashboard

# ---- 3. The app image: every Node service uses it; compose picks the command ----
FROM node:22-slim AS app
WORKDIR /app
COPY --from=deps /app ./
COPY . .
USER node
CMD ["node", "--import", "tsx", "apps/ingest/src/server.ts"]

# ---- 4. The website: nginx serving the dashboard and proxying the rest ----
FROM nginx:1.27-alpine AS web
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard-build /app/apps/dashboard/dist /usr/share/nginx/html
