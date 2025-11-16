## Spot subgraph

The Graph is a tool for for indexing events emitted on the Ethereum blockchain. It provides you with an easy-to-use GraphQL API.

```
Public graphql endpoint:
https://api.goldsky.com/api/public/project_cmgzjl03n004g5np20v5j3qpx/subgraphs/ampleforth-spot/prod/gn
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

To build and deploy the subgraph to the goldsky's hosted service:

```
# local deployment
./scripts/deploy-local.sh sepolia ampleforth-spot-sepolia

# prod deployment

You should have your own Goldsky API key to use with the Goldsky CLI.
Note you must set the (new) version to deploy to, and then update the tag separately.

```
./scripts/deploy.sh sepolia <VERSION> ampleforth-spot-sepolia
./scripts/deploy.sh mainnet <VERSION> ampleforth-spot
```

Once deployed, update the tag that frg-web-api looks for.

```
goldsky subgraph tag create <SUBGRAPH-NAME>/<VERSION> --tag prod
```
