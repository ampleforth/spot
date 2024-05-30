# spot-staking-subgraph

Ancillary subgraphs to keep track of spot staking. 


```
yarn codegen

yarn build

yarn graph deploy spot-staking \
  --node https://subgraphs.alchemy.com/api/subgraphs/deploy \
  --deploy-key $GRAPH_AUTH \
  --ipfs https://ipfs.satsuma.xyz
```