#!/bin/sh
# Resolve the optional Dispatch token when Claude Code opens an MCP connection.
set -eu
set -a
. /root/.bootstrap.env
set +a
exec /usr/bin/op run --env-file=/root/env/dispatch.env.op -- \
  /root/.nvm/versions/node/v24.19.0/bin/node \
  /root/workspace/dev/dispatch/main/scripts/headers.mjs
