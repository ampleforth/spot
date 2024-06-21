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

# NOTE: Ensure that the docker container is able to access the internet
```

Setup project:
```
yarn
```

To build and deploy the subgraph to the graph hosted service:

```
# local deployment
./scripts/deploy-local.sh sepolia ampleforth-spot-sepolia

# prod deployment
./scripts/deploy.sh sepolia ampleforth-spot-sepolia
./scripts/deploy.sh mainnet ampleforth-spot
```