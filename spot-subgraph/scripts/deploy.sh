#!/bin/bash
set -e

yarn mustache ../spot-contracts/deployments/$1.json subgraph.template.yaml > ./subgraph.yaml

yarn codegen

yarn build

echo "NOTE: graph deploy to Alchemy fails when you redeploy with the same IPFS hash"

# yarn graph auth $THE_GRAPH_API_KEY
# yarn graph deploy $2
yarn graph deploy $2 \
  --node https://subgraphs.alchemy.com/api/subgraphs/deploy \
  --deploy-key $GRAPH_AUTH
