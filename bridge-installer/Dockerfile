# Built on the Home Assistant machine itself, so there is no image to publish.
# The base is named here and not taken from BUILD_FROM, so the result does not
# depend on which base the Supervisor of the day would have chosen.
FROM alpine:3.22

# The bridge, at one commit: a tag can be moved, a commit cannot. BRIDGE_VERSION
# is what that commit's manifest must say, and config.yaml's `version` too.
ARG BRIDGE_COMMIT=1befb33ef5179f4f9b83841d05fbe4722f0debcb
ARG BRIDGE_VERSION=2026.10.3

ADD https://github.com/turzi-org/turzi-bridge-for-home-assistant/archive/${BRIDGE_COMMIT}.tar.gz /tmp/bridge.tar.gz
RUN mkdir -p /opt/turzi \
 && tar -xzf /tmp/bridge.tar.gz -C /tmp \
 && mv /tmp/turzi-bridge-for-home-assistant-${BRIDGE_COMMIT}/custom_components/turzi_bridge /opt/turzi/turzi_bridge \
 && grep -q "\"version\": \"${BRIDGE_VERSION}\"" /opt/turzi/turzi_bridge/manifest.json \
 && rm -rf /tmp/*

COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
