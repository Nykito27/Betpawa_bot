FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install


COPY . .

CMD [ "node", "index.js" ]
