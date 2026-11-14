# Momentum server image: the API, the built web app and the email sender in one small Node process.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    ENVIRONMENT=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=1 \
    DATABASE_PATH=/data/momentum.db \
    STATIC_DIR=/app/client \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /src/dist/server ./server
COPY --from=build /src/dist/client ./client
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "--enable-source-maps", "server/main.mjs"]