FROM node:26-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY config ./config

ENV RELOAD_TOKEN=""

EXPOSE 9000

CMD ["node", "server.js"]
