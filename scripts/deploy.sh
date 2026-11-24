#!/usr/bin/env bash
# Deploy the committed code (HEAD) to the Akamai server: copy it over, rebuild the image there, restart.
#   bash scripts/deploy.sh            (uses ~/.ssh/momentum-deploy and the server below)
set -euo pipefail

HOST="${MOMENTUM_HOST:-172.105.0.58}"
KEY="${MOMENTUM_KEY:-$HOME/.ssh/momentum-deploy}"
SSH="ssh -i $KEY -o BatchMode=yes deploy@$HOST"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- src migrations public index.html package.json package-lock.json Dockerfile deploy)" ]; then
  echo "Commit your changes first: only committed code is deployed." >&2
  exit 1
fi

echo "Deploying $(git rev-parse --short HEAD) to $HOST"
$SSH "rm -rf /opt/momentum/src.new && mkdir -p /opt/momentum/src.new"
git archive --format=tar HEAD | $SSH "tar -x -C /opt/momentum/src.new"
$SSH "cd /opt/momentum && rm -rf src && mv src.new src && cp src/deploy/compose.yml src/deploy/Caddyfile src/deploy/litestream.yml . && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null"
echo "Deployed. Checking health..."
$SSH "for i in \$(seq 1 30); do docker compose -f /opt/momentum/compose.yml exec -T app wget -qO- http://127.0.0.1:8787/healthz && exit 0; sleep 2; done; exit 1"
echo