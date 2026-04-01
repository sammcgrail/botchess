FROM node:20-alpine
RUN apk add --no-cache sqlite python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
EXPOSE 20007
CMD ["node", "server.js"]
