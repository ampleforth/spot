## Spot

[![Nightly](https://github.com/ampleforth/spot/actions/workflows/nightly.yml/badge.svg)](https://github.com/ampleforth/spot/actions/workflows/nightly.yml)&nbsp;&nbsp;[![Coverage Status](https://coveralls.io/repos/github/ampleforth/spot/badge.svg?branch=main&t=Qptbxq)](https://coveralls.io/github/ampleforth/spot?branch=main)

SPOT is an inflation-resistant store of value fully collateralized by AMPL backed derivatives. [Learn more](https://spot.cash)

Mainnet Deployment is available at these addresses:
- SPOT ERC-20 Token: [0xC1f33e0cf7e40a67375007104B929E49a581bafE](https://etherscan.io/address/0xC1f33e0cf7e40a67375007104B929E49a581bafE)
- Router: [0x38f600e08540178719BF656e6B43FC15A529c393](https://etherscan.io/address/0x38f600e08540178719BF656e6B43FC15A529c393)
- Bond Factory: [0x72799FFD1F4CCF92eA2b1eE0CADa16a5461c4d96](https://etherscan.io/address/0x72799FFD1F4CCF92eA2b1eE0CADa16a5461c4d96)
- Bond Issuer: [0x9443b779d4AedF97d2B93D7CDa5fA0BB6312DfF2](https://etherscan.io/address/0x9443b779d4AedF97d2B93D7CDa5fA0BB6312DfF2)
- Proxy Admin: [0x2978B4103985A6668CE345555b0febdE64Fb092F](https://etherscan.io/address/0x2978B4103985A6668CE345555b0febdE64Fb092F)

Goerli Testnet Deployment can be found [here](spot-contracts/deployments/goerli.json)


### Package organization

* [spot-contracts](./spot-contracts): SPOT protocol smart contracts. 

## Licensing

The primary license for Spot is the Business Source License 1.1 (`BUSL-1.1`), see [`LICENSE`](./LICENSE). However, some files are dual licensed under `GPL-3.0-or-later`:

- All files in `spot-contracts/contracts/_interfaces/` may also be licensed under `GPL-3.0-or-later` (as indicated in their SPDX headers), see [`spot-contracts/contracts/_interfaces/LICENSE`](./spot-contracts/contracts/_interfaces/LICENSE)
