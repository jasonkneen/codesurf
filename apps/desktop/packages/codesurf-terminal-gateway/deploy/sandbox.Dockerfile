# Deliberately small base image for CODESURF_TERMINAL_ADAPTER=docker.
# Build it, pin the resulting tag/digest, then add only approved developer CLIs.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git procps \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 codesurf \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash codesurf

WORKDIR /workspace
ENV HOME=/tmp \
    TERM=xterm-256color \
    LANG=C.UTF-8
USER 1000:1000

CMD ["/bin/bash", "-l"]
