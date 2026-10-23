# syntax=docker/dockerfile:1

# ---- build: compile the SPA -------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Empty = same origin as the page (nginx proxies /api).
ARG VITE_API_BASE=""
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ---- serve (default): nginx as a non-root user, SPA fallback, /api proxy ----
FROM nginx:1.29-alpine AS serve
# host:port of console-api; resolved per request through Docker's embedded DNS.
ENV API_UPSTREAM=console-api:3001 \
    DNS_RESOLVER=127.0.0.11
# Run as the image's unprivileged "nginx" user: the pid file moves to /tmp, the cache and the
# envsubst output dir become writable. The entrypoint's IPv6 helper only edits the removed
# default.conf, so it is dropped too.
RUN rm -f /etc/nginx/conf.d/default.conf /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
    && sed -i -e 's#^pid .*#pid /tmp/nginx.pid;#' -e '/^user /d' /etc/nginx/nginx.conf \
    && mkdir -p /etc/nginx/snippets \
    && chown -R nginx:nginx /var/cache/nginx /etc/nginx/conf.d
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/ /usr/share/nginx/html/
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
