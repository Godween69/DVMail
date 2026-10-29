# Образ админки ящиков DVMail (многоступенчатая сборка).
# Контекст сборки: корень репозитория. Команда: docker build -f apps/admin/Dockerfile .
ARG NODE_IMAGE=node:22-alpine

# --- Ступень 1: сборка TypeScript (здесь есть dev-зависимости, в итоговый образ они не попадут)
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci --workspace @dvmail/admin --no-audit --no-fund
RUN npm run build --workspace @dvmail/admin

# --- Ступень 2: только рабочие зависимости
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY . .
RUN npm ci --omit=dev --workspace @dvmail/admin --no-audit --no-fund

# --- Ступень 3: итоговый образ
FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app/apps/admin
COPY --from=deps  /app/node_modules /app/node_modules
COPY --from=build /app/apps/admin/dist ./dist
COPY --from=build /app/apps/admin/public ./public
COPY --from=build /app/apps/admin/package.json ./package.json
# Запуск без root (пользователь node, uid 1000 уже есть в образе)
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
