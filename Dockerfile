# One Piece Looks — mock demo image (client static + Fastify /api).
# YOUCAM_MOCK=1 by default; do not bake API keys into the image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci
COPY apps/server apps/server
COPY apps/client apps/client
RUN npm run build -w apps/client && npm run build -w apps/server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    YOUCAM_MOCK=1 \
    CLIENT_DIST=/app/apps/client/dist
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --omit=dev -w apps/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/client/dist apps/client/dist
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
