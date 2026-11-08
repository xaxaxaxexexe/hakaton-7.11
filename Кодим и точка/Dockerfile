FROM node:24-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=4173 HOST=0.0.0.0 DB_PATH=/data/arena.sqlite
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 4173
CMD ["node", "server.cjs"]
