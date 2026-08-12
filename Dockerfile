# O mesmo sistema em container Docker (alt. para Render runtime Docker, VPS, Oracle free tier, etc.)
# node:sqlite requer Node >= 22 (embutido, sem compilação nativa).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package-lock.json server/
COPY client/package.json client/package-lock.json client/

RUN npm ci --prefix server && npm ci --prefix client

COPY . .

ENV NODE_ENV=production
ENV PORT=4000

RUN npm run build --prefix client

EXPOSE 4000

CMD ["node", "server/src/index.js"]