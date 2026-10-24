# The heavy runners' image (#60), built on this machine by `factory ci install`: GitHub's runner image plus the
# tools the project's jobs would otherwise download on every job, so `actions/setup-node`, pnpm and
# `playwright install` find them already there.
#   NODE_VERSION        from .nvmrc ("24", "24.1" or "24.1.0"): the newest matching release, in the tool cache that
#                       actions/setup-node looks in first (/opt/hostedtoolcache/node/<version>/<arch>)
#   PNPM_VERSION        from package.json's packageManager: activated with corepack
#   PLAYWRIGHT_VERSION  from the lockfile: its Chromium and the system libraries it needs, in /ms-playwright
# Each is skipped when empty. Nothing here is a secret, and nothing from a job is ever written back into it.
ARG RUNNER_VERSION=2.338.0
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}
ARG NODE_VERSION=
ARG PNPM_VERSION=
ARG PLAYWRIGHT_VERSION=
USER root
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache \
    COREPACK_HOME=/opt/corepack \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FACTORY_CI_IMAGE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 git \
 && rm -rf /var/lib/apt/lists/*
COPY install-tools.sh /tmp/install-tools.sh
RUN NODE_VERSION="$NODE_VERSION" PNPM_VERSION="$PNPM_VERSION" PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" \
    bash /tmp/install-tools.sh && rm -f /tmp/install-tools.sh
# The pnpm store's mount point, owned by the runner user, so the shared store volume is writable.
RUN mkdir -p /cache/pnpm-store /opt/hostedtoolcache /opt/corepack /ms-playwright \
 && chown -R runner:runner /cache /opt/hostedtoolcache /opt/corepack \
 && chmod -R a+rX /ms-playwright
USER runner
