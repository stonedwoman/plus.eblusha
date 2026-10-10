# Бот «Еблуша» (bot/): сборка TypeScript и рантайм. Контекст сборки — каталог bot/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-alpine
# Шрифт с кириллицей для карточек карты Valheim (SVG-подписи → PNG через sharp/librsvg).
RUN apk add --no-cache fontconfig font-dejavu && fc-cache -f
# Корень только для чтения: кэш fontconfig — во временном /tmp (tmpfs в compose).
ENV NODE_ENV=production \
    BOT_DATA_DIR=/data \
    BOT_ASSETS_DIR=/app/assets \
    XDG_CACHE_HOME=/tmp/.cache
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY assets ./assets
# Каталог данных (SQLite) принадлежит node: именованный том при первом подключении унаследует владельца.
RUN mkdir -p /data && chown node:node /data
USER node
# node:sqlite в Node 22 помечен экспериментальным — предупреждение гасим, чтобы не шумело в журнале.
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/main.js"]
