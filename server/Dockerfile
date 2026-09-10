FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# The database is a file, so it must live on a mounted volume or it is lost
# on every redeploy.
ENV STRANDLINE_DB=/data/strandline.sqlite
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
