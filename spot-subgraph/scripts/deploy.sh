#!/bin/bash
set -e

yarn mustache ../spot-contracts/deployments/$1.json subgraph.template.yaml > ./subgraph.yaml

goldsky subgraph deploy $2/$3 --path .
