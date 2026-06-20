# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS package

ARG PI_WEB_VERSION=latest
ARG PI_VERSION=latest
ARG CACHE_BUST=local

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  echo "PI WEB Docker build cache bust: ${CACHE_BUST}"; \
  npm install -g --omit=dev --no-audit --no-fund \
    "@jmfederico/pi-web@${PI_WEB_VERSION}" \
    "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
  npm cache clean --force

FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
  NPM_CONFIG_UPDATE_NOTIFIER=false \
  HOME=/data/home \
  XDG_CONFIG_HOME=/data/config \
  PI_WEB_HOST=0.0.0.0 \
  PI_WEB_PORT=8504 \
  PI_WEB_DATA_DIR=/data/pi-web \
  PI_WEB_SESSIOND_SOCKET=/data/pi-web/sessiond.sock \
  PI_CODING_AGENT_DIR=/data/pi-agent \
  SHELL=/bin/bash \
  TERM=xterm-256color

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/home /data/config /data/pi-web /data/pi-agent /workspace \
  && chown -R node:node /data /workspace

COPY --from=package /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=package /usr/local/bin /usr/local/bin

WORKDIR /workspace
USER node

EXPOSE 8504

ENTRYPOINT ["tini", "--"]
CMD ["pi-web-server"]
