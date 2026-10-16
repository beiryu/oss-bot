# Sandbox for every agent and gate command. The host passes in only the agent's
# model credential (a Copilot-only token), and only to agent runs.
FROM node:22-bookworm-slim AS node
FROM ubuntu:26.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g @github/copilot@1.0.95 && copilot --version

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 build-essential ripgrep libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

# Go for Go projects (agent-substrate/substrate needs 1.27; older go.mod lines build fine). GOTOOLCHAIN=local stops a
# repo's go.mod from making the sandbox download another toolchain.
ARG GO_VERSION=1.27.2
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz \
 && ln -s /usr/local/go/bin/go /usr/local/bin/go && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
 && go version
ENV GOTOOLCHAIN=local

# uv for Python projects. Projects pick their own interpreter; uv downloads
# it into the cache volume below, so the system python3 version does not matter.
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /usr/local/bin/

RUN useradd -m -u 1000 -s /bin/bash bot || useradd -m -s /bin/bash bot
USER bot
ENV HOME=/home/bot PATH=/home/bot/.local/bin:/home/bot/go/bin:$PATH \
    GOMODCACHE=/home/bot/.cache-vol/go/mod GOCACHE=/home/bot/.cache-vol/go/build \
    UV_CACHE_DIR=/home/bot/.cache-vol/uv/cache UV_PYTHON_INSTALL_DIR=/home/bot/.cache-vol/uv/python \
    UV_LINK_MODE=copy

# Claude Code stays available as an alternative runtime (sandbox.runtime: claude).
RUN curl -fsSL https://claude.ai/install.sh | bash \
 && claude --version

# Agents commit/diff inside the container; give git an identity there.
RUN git config --global user.name "oss-bot" \
 && git config --global user.email "oss-bot@localhost" \
 && git config --global --add safe.directory '*' \
 && mkdir -p /home/bot/.cache-vol

WORKDIR /work
