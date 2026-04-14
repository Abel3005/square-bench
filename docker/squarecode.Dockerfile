# Step 1: an image with squarecode installed and runnable.
#
# Base matches the swebench eval image family (ubuntu:22.04), so later steps
# can reuse the same layer when we build on top of sweb.eval.x86_64.* images.
#
# Build context must be the squarecode source tree, e.g.:
#   docker build -f docker/squarecode.Dockerfile \
#     -t square-bench/squarecode:latest \
#     /home/dev/workspace/squarecode
#
# Secrets (auth.json) are NOT baked in — mount them at runtime:
#   docker run --rm -it \
#     -v $HOME/.local/share/squarecode/auth.json:/root/.local/share/squarecode/auth.json:ro \
#     -v $HOME/.config/squarecode/squarecode.json:/root/.config/squarecode/squarecode.json:ro \
#     -v $HOME/.local/state/squarecode/model.json:/root/.local/state/squarecode/model.json:ro \
#     square-bench/squarecode:latest squarecode --version

FROM ubuntu:22.04

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy the prebuilt squarecode distribution. The node shim at bin/squarecode
# resolves dist/squarecode-<platform>-<arch>/bin/squarecode at runtime, where
# arch is node's os.arch() — "x64" or "arm64".
WORKDIR /opt/squarecode
COPY bin/squarecode ./bin/squarecode
COPY package.json ./package.json
COPY dist/ ./dist/
RUN case "${TARGETARCH}" in \
      amd64) keep="squarecode-linux-x64" ;; \
      arm64) keep="squarecode-linux-arm64" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && find dist -mindepth 1 -maxdepth 1 -type d ! -name "$keep" -exec rm -rf {} +

RUN ln -s /opt/squarecode/bin/squarecode /usr/local/bin/squarecode \
    && mkdir -p /root/.config/squarecode \
                /root/.local/share/squarecode \
                /root/.local/state/squarecode

CMD ["squarecode", "--version"]
