# crew's site: the static files `bun site/build.ts` wrote to site/dist, served by Caddy on :80.
# TLS is the edge proxy's job on the server.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY dist /srv

EXPOSE 80
