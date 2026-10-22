# Pin the Node release; record the resolved digest when validating a release.
FROM node:24.16.0-bookworm-slim
ENV NODE_ENV=production \
    QQ_AGENT_DATA_DIR=/var/lib/qq-agent \
    QQ_AGENT_HOST=0.0.0.0 \
    QQ_AGENT_PORT=3210
WORKDIR /opt/qq-agent
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY src/ ./src/
COPY ui/ ./ui/
COPY LICENSE ./
COPY deploy/config.linux.example.json ./deploy/config.linux.example.json
COPY deploy/init-data.mjs ./deploy/init-data.mjs
# Empty extension directories: explicitly mount reviewed extensions read-only.
RUN mkdir -p /var/lib/qq-agent skills plugins \
    && chown node:node /var/lib/qq-agent \
    && chmod 700 /var/lib/qq-agent
USER node
EXPOSE 3210
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:'+process.env.QQ_AGENT_PORT+'/healthz',{signal:AbortSignal.timeout(4000)});process.exit(r.ok?0:1)"]
CMD ["node", "src/server.js"]
