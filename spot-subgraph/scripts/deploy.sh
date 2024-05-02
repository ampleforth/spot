#!/bin/bash
set -e

yarn mustache ../spot-contracts/deployments/$1.json subgraph.template.yaml > ./subgraph.yaml

yarn codegen

yarn build

yarn graph deploy $2 \
  --node https://subgraphs.alchemy.com/api/subgraphs/deploy \
  --deploy-key $GRAPH_AUTH \
  --ipfs https://ipfs.satsuma.xyz