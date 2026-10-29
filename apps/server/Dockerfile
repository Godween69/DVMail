# Образ веб-клиента DVMail: сервер NestJS и собранный сайт React в одном контейнере (многоступенчатая сборка).
# Контекст сборки: корень репозитория. Команда: docker build -f apps/server/Dockerfile -t dvmail-web .
ARG NODE_IMAGE=node:22-alpine

# --- Ступень 1: сборка сервера и сайта (здесь есть dev-зависимости, в итоговый образ они не попадут).
# --ignore-scripts: скрипты установки чужих пакетов не запускаются.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci --workspace @dvmail/server --workspace @dvmail/web --ignore-scripts --no-audit --no-fund
RUN npm run build --workspace @dvmail/server && npm run build --workspace @dvmail/web

# --- Ступень 2: только рабочие зависимости сервера
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --workspace @dvmail/server --ignore-scripts --no-audit --no-fund

# --- Ступень 3: итоговый образ
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_ROOT=/app/apps/web/dist
WORKDIR /app/apps/server
COPY --from=deps  /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/server/package.json ./package.json
COPY --from=build /app/apps/web/dist /app/apps/web/dist
# Запуск без root (пользователь node, uid 1000 уже есть в образе)
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
