# PrintMap — image de production pour Coolify (serveur Hetzner).
# Un seul conteneur, sans base de données ni volume : l'app collecte les
# données à la demande auprès de services publics, il lui faut donc un accès
# Internet sortant.

FROM node:22-alpine AS deps
WORKDIR /app
# Le postinstall copie le moteur WASM et le worker de carte dans public/ :
# son script doit exister avant `npm ci`.
COPY package.json package-lock.json ./
COPY scripts/setup-wasm.mjs ./scripts/setup-wasm.mjs
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `standalone` ne garde que les dépendances réellement utilisées par le
# serveur. Activé ici seulement, pour ne rien changer à `npm start` en local.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# public/ et .next/static ne sont pas inclus dans standalone : sans eux, pas
# de moteur 3D (manifold.wasm), pas de worker de carte, pas de CSS ni de JS.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", "server.js"]
