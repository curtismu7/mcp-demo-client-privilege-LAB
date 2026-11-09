FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY server.js llm.js shelfLink.js safety.js ./
COPY public ./public
EXPOSE 6884
USER node
CMD ["node", "server.js"]
