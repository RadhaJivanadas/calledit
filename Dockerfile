FROM node:20-alpine AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ server/
COPY scripts/ scripts/
COPY data/replays/ data/replays/
COPY --from=webbuild /app/web/dist web/dist
EXPOSE 3000
CMD ["node", "server/index.js"]
