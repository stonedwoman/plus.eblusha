# Eblusha Cloud face worker: Debian вместо alpine — onnxruntime-node требует glibc.
FROM node:22-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends unzip openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma/
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/dist ./dist
COPY --from=base /app/package.json ./
CMD ["node", "dist/faceWorker.js"]
