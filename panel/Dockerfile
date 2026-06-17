FROM node:22-alpine

RUN apk add --no-cache bash tar

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PANEL_PORT=8080 \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspace \
    COMPOSE_ENV_FILE=/workspace/.env \
    RUNTIME_ENV_FILE=/data/server.env \
    BACKUP_DIR=/workspace/backups

EXPOSE 8080/tcp

CMD ["npm", "start"]
