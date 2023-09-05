#!/bin/bash
set -e

yarn mustache ../spot-contracts/deployments/$1.json subgraph.template.yaml > ./subgraph.yaml

yarn codegen

yarn build

yarn create-local

yarn deploy-local
