# syntax=docker/dockerfile:1
# oci-free-vm — lightweight container image.
#
# Multi-stage build:
#   * build   — npm ci + esbuild bundle (dist/index.js, no runtime node_modules)
#   * runtime — node:24-alpine carrying only dist/index.js and package.json
#
# Usage:
#   docker build -t oci-free-vm .
#
#   # mount your OCI credentials (read-only), your SSH keys, and a working directory:
#   docker run --rm -it \
#     -v ~/.oci:/home/node/.oci:ro \
#     -v ~/.ssh:/home/node/.ssh \
#     -v "$PWD:/home/node/work" \
#     oci-free-vm
#
# The CLI resolves ./oci-free-vm.yaml and ./oci-free-vm-logs/ relative to its
# working directory (/home/node/work — mount a directory there to persist
# state between runs) and reads OCI credentials from ~/.oci/config.
# ~/.ssh is mounted read-write so the interactive prompt can generate a new
# ed25519 key pair; OCI_CONFIG_FILE overrides the credential path and
# OCI_FREE_VM_ENDPOINT overrides all SDK endpoints (useful for testing).

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
LABEL org.opencontainers.image.title="oci-free-vm" \
      org.opencontainers.image.description="Deploy an OCI VM and automatically retry when capacity is unavailable." \
      org.opencontainers.image.source="https://github.com/yokharian/oracle-free-tier-retrier" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
# ssh-keygen for the interactive "Generate a new SSH key pair" option.
RUN apk add --no-cache openssh-keygen
COPY --from=build /app/dist/index.js ./dist/index.js
# package.json is read at runtime (appVersion() for --version/--help output).
COPY --from=build /app/package.json ./package.json

# The CLI writes oci-free-vm.yaml and oci-free-vm-logs/ into its working
# directory, so give the non-root user a writable one and make it the default.
RUN mkdir -p /home/node/work && chown node:node /home/node/work
WORKDIR /home/node/work

# node:24-alpine ships a non-root `node` user (uid 1000).
USER node

ENTRYPOINT ["node", "/app/dist/index.js"]
