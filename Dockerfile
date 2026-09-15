FROM node:26-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY config ./config

ENV PORT=9000
EXPOSE 9000

CMD ["node", "server.js"]
