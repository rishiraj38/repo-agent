FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production WORKSPACE_DIR=/data/workspaces PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
