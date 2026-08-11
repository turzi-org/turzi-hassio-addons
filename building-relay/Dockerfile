# Turzi building relay as a Home Assistant add-on. Uses its own base
# (OpenResty) rather than BUILD_FROM — the relay is nginx+Lua, not an
# HA-flavored service.
FROM openresty/openresty:alpine
RUN apk add --no-cache gettext curl jq
COPY nginx.conf.tmpl /etc/relay/nginx.conf.tmpl
COPY run.sh /run.sh
RUN chmod +x /run.sh
ENTRYPOINT ["/run.sh"]
