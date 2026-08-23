FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "--experimental-sqlite", "server/server.js"]
