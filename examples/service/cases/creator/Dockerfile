# The Chatwarden service API as a container. A recipe, not an image: build it yourself. No secret goes in the image; the keys come from the environment when it runs.
# Written by `chatwarden init --service`. It is yours now: edit freely. Re-running never overwrites a file you changed.

FROM node:22-slim
ARG CHATWARDEN_VERSION=0.2.1
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund \
    @chatwarden/core@${CHATWARDEN_VERSION} \
    @chatwarden/http@${CHATWARDEN_VERSION} \
    @chatwarden/store-sqlite@${CHATWARDEN_VERSION} \
    @chatwarden/matcher@${CHATWARDEN_VERSION} \
    @chatwarden/profanity@${CHATWARDEN_VERSION} \
    @chatwarden/hub-element@${CHATWARDEN_VERSION}
COPY profile.json /app/profile.json
RUN mkdir -p /data && chown node:node /data
ENV CHATWARDEN_DB=/data/chatwarden.db CHATWARDEN_HOST=0.0.0.0 CHATWARDEN_PROFILE_FILE=/app/profile.json
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "node_modules/.bin/chatwarden", "serve"]
