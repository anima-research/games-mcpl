FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir vizdoom==1.3.1 numpy pillow
ENV NODE_ENV=production PORT=8080 GAMES_HOST=0.0.0.0 GAMES_DATA_DIR=/data GAMES_PYTHON=/opt/venv/bin/python GAMES_SIDECAR=/app/py/sidecar.py DOOM_WAD_DIR=/app/wads
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY py/sidecar.py ./py/sidecar.py
COPY wads ./wads
COPY package.json ./
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
