## Spot

<img src="https://assets.coingecko.com/coins/images/28426/small/SPOT_Logo_200x200_square.png" /> 

SPOT is an inflation-resistant store of value fully collateralized by AMPL backed derivatives. [Learn more](https://spot.cash/).

[![Nightly](https://github.com/ampleforth/spot/actions/workflows/nightly.yml/badge.svg)](https://github.com/ampleforth/spot/actions/workflows/nightly.yml)&nbsp;&nbsp;[![Coverage Status](https://coveralls.io/repos/github/ampleforth/spot/badge.svg?branch=main)](https://coveralls.io/github/ampleforth/spot?branch=main)

Security contact: [dev-support@ampleforth.org](mailto:dev-support@ampleforth.org)


### Package organization

* [spot-contracts](./spot-contracts): SPOT protocol smart contracts. 
* [spot-subgraph](./spot-subgraph): Subgraph to index SPOT protocol on-chain data. 

## Licensing

The primary license for Spot is the Business Source License 1.1 (`BUSL-1.1`), see [`LICENSE`](./LICENSE). However, some files are dual licensed under `GPL-3.0-or-later`:

- All files in `spot-contracts/contracts/_interfaces/` may also be licensed under `GPL-3.0-or-later` (as indicated in their SPDX headers), see [`spot-contracts/contracts/_interfaces/LICENSE`](./spot-contracts/contracts/_interfaces/LICENSE)

- All files in `spot-subgraph` may also be licensed under `GPL-3.0-or-later`, see [`spot-subgraph/LICENSE`](./spot-subgraph/LICENSE)
