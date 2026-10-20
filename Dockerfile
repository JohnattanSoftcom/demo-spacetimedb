# Image of the TransVille Live web app: the Angular build served by nginx.
# The SpacetimeDB server is NOT in here -- docker-compose.yml runs the official
# clockworklabs/spacetime image next to it, and the module is published by hand with the CLI.

# ---- Build: production Angular bundle -------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so the layer is cached until package*.json change.
COPY demo-app/package.json demo-app/package-lock.json ./
RUN npm ci

# The TypeScript bindings (src/module_bindings) are committed: no `spacetime generate` here.
COPY demo-app/ ./
RUN npm run build

# ---- Runtime: static files behind nginx ------------------------------------------------------
FROM nginx:1-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/demo-app/browser /usr/share/nginx/html
EXPOSE 80
