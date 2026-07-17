# ═══════════════════════════════════════════════════════════════════════════
# Youthnic Packing Station — Cloud Run Production Dockerfile
# Single-container: React frontend built + served by Express backend
# Deployed to Cloud Run (consignment-pack / consignment-packing, europe-west1)
# ═══════════════════════════════════════════════════════════════════════════

# ─── Stage 1: Build Frontend (Alpine is fine — no native modules) ────────────
FROM node:22-alpine AS frontend-builder

# Vite bakes VITE_* at build time. Pass via --build-arg (CI) — do not rely on
# frontend/.env.production alone (gitignored / excluded from Docker context).
ARG VITE_API_URL=
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MEASUREMENT_ID=
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG VITE_POSTHOG_KEY=
ARG VITE_POSTHOG_HOST=https://us.i.posthog.com
ARG VITE_POSTHOG_DASHBOARD_URL=
ARG VITE_BETTERSTACK_DASHBOARD_URL=

ENV VITE_API_URL=$VITE_API_URL \
    VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_FIREBASE_MEASUREMENT_ID=$VITE_FIREBASE_MEASUREMENT_ID \
    VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    VITE_POSTHOG_DASHBOARD_URL=$VITE_POSTHOG_DASHBOARD_URL \
    VITE_BETTERSTACK_DASHBOARD_URL=$VITE_BETTERSTACK_DASHBOARD_URL

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ─── Stage 2: Production Backend (slim = Debian, required for Firebase gRPC) ─
# DO NOT use Alpine here — Firebase Admin SDK uses gRPC which needs
# glibc (Debian/Ubuntu). Alpine uses musl libc and breaks native modules.
# Node 22+: required by AWS SDK for JavaScript v3 after early Jan 2027.
FROM node:22-slim AS production

WORKDIR /app/backend

# Install production dependencies
COPY backend/package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy backend source
COPY backend/ ./

# Copy built frontend static files
# server.js expects them at ../frontend/dist relative to __dirname
COPY --from=frontend-builder /app/frontend/dist ../frontend/dist

# Cloud Run auto-injects PORT=8080
ENV NODE_ENV=production
ENV PORT=8080
# Keep heap under Cloud Run 1Gi limit (leave room for native + buffers).
ENV NODE_OPTIONS=--max-old-space-size=768

EXPOSE 8080

CMD ["node", "server.js"]
