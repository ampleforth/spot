# spot-staking-subgraph

Ancillary subgraphs to keep track of spot staking.

You should have your own Goldsky API key to use with the Goldsky CLI.

Note you must set the (new) version to deploy to, and then update the tag separately.
```
goldsky subgraph deploy spot-staking/<VERSION> --path .
```

Once deployed, update the tag that frg-web-api looks for.
```
goldsky subgraph tag create spot-staking/<VERSION> --tag prod
```
