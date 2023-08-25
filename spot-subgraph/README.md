## Spot subgraph

The Graph is a tool for for indexing events emitted on the Ethereum blockchain. It provides you with an easy-to-use GraphQL API.

```
Public graphql endpoint:
https://api.thegraph.com/subgraphs/name/ampleforth/spot
```

## Getting started

Run a local instance of the graph node:

```
git clone https://github.com/graphprotocol/graph-node
cd graph-node/docker

# update docker-compose.yaml with alchemy rpc endpoint
docker-compose up
```

Setup project:
```
yarn global add mustache
yarn
```

To build and deploy the subgraph to the graph hosted service:

```
# local deployment
./scripts/deploy-local.sh goerli ampleforth/spot-goerli

# prod deployment
./scripts/deploy.sh goerli ampleforth/spot-goerli
./scripts/deploy.sh mainnet ampleforth/spot
```