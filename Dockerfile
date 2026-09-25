FROM node:20-alpine

WORKDIR /app

# Copy application files (zero npm install required)
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

USER node

CMD ["node", "server.js"]
