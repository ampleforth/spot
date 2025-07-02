#!/bin/bash

# generate-ipfs-cid.sh
# Computes IPFS CID of a given directory using IPFS in Docker without uploading

set -e

TARGET_PATH=${1:-build}

if [ ! -d "$TARGET_PATH" ]; then
  echo "❌ Error: Directory '$TARGET_PATH' does not exist."
  echo "Usage: $0 [path-to-directory]"
  exit 1
fi

echo "📦 Computing IPFS CID for '$TARGET_PATH'..."

CID=$(docker run --rm \
  -v "$(pwd):/data" \
  -e IPFS_PATH=/tmp/ipfs \
  --entrypoint sh \
  ipfs/kubo \
  -c "ipfs init >/dev/null && ipfs add -r --only-hash --quiet /data/$TARGET_PATH" | tail -n 1)

if [ -z "$CID" ]; then
  echo "❌ Failed to generate IPFS CID."
  exit 1
fi

echo "✅ IPFS CID: $CID"
