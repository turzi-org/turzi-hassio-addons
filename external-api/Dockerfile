# Build stage — dev dependencies stay here, out of the shipped image.
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage.
#
# Its own base rather than BUILD_FROM, the same choice (and for the same
# reason) as the building-relay add-on: this is a Node service, not an
# HA-flavored one, and node:24-alpine is multi-arch for both amd64 and aarch64.
# Node 24 specifically — nothing here needs a native module, so there is no
# compile step on a slow ARM box.
FROM node:24-alpine

ENV NODE_ENV=production

# For run.sh in add-on mode: reading /data/options.json and asking the
# Supervisor for broker and database credentials.
RUN apk add --no-cache jq curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY run.sh /run.sh
RUN chmod +x /run.sh

# Nothing here needs root: the add-on writes no files (the log lives in
# MariaDB) and 8080 is unprivileged.
USER node

EXPOSE 8080

# No curl-based probe in the shipped healthcheck path beyond what is already
# installed; node makes the request itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["/run.sh"]
