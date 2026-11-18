FROM node:24.13.0-bookworm-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install --global npm@11.11.1 && npm ci --no-audit --no-fund
COPY frontend/ ./
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN node -e "const u=new URL(process.env.VITE_API_BASE_URL); if(u.protocol!=='https:'||u.pathname!=='/api'||u.search||u.hash||u.username||u.password) process.exit(1)" && npm run build

FROM caddy:2.10.2-alpine
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
