FROM node:24.13.0-bookworm-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm install --global npm@11.11.1 && npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run typecheck && npm run build

FROM node:24.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm install --global npm@11.11.1 && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY backend/scripts/admin.cjs backend/scripts/uat.cjs backend/scripts/uat-demo.cjs ./scripts/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
