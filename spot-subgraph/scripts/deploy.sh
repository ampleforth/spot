#!/bin/bash
set -e

mustache ../spot-contracts/deployments/$1.json subgraph.template.yaml > ./subgraph.yaml

yarn auth $GRAPH_AUTH

yarn codegen

yarn build

yarn graph deploy \
	--product hosted-service \
	--access-token $GRAPH_AUTH $2
