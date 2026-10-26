FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data CHROME_BIN=/usr/bin/chromium JOBFORGE_DOCKER=1
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:8787/api/v1/version', { signal: AbortSignal.timeout(8000) }); if (!r.ok) process.exit(1);"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
