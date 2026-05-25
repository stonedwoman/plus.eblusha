# Eblusha Plus backend + worker
FROM node:22-alpine AS base

WORKDIR /app

# Install dependencies (include dev for TypeScript build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Build TypeScript
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# Prune dev deps for smaller final image
RUN npm prune --omit=dev

# Production image
FROM node:22-alpine

WORKDIR /app

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/dist ./dist
COPY --from=base /app/package.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
# Default: run server (override with command for worker)
CMD ["node", "dist/server.js"]
