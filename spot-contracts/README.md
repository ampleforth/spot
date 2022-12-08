## Spot contracts

This repository is a collection of smart contracts that implement the SPOT perpetual note on the Ethereum blockchain.

The official mainnet addresses are:

- SPOT ERC-20 Token: [0xC1f33e0cf7e40a67375007104B929E49a581bafE](https://etherscan.io/address/0xC1f33e0cf7e40a67375007104B929E49a581bafE)
- Bond issuer: [0xD64FA63dc5E8fcB743457E47E4d522E11Ff1AD66](https://etherscan.io/address/0xD64FA63dc5E8fcB743457E47E4d522E11Ff1AD66)
- Router: [0x38f600e08540178719BF656e6B43FC15A529c393](https://etherscan.io/address/0x38f600e08540178719BF656e6B43FC15A529c393)

## Install

```bash
# Install project dependencies
yarn
```

## Testing

```bash
# Run all unit tests (compatible with node v12+)
yarn test
```

### Testnets

There is a testnet deployment on Goerli.

- SPOT ERC-20 Token: [0x95014Bc18F82a98CFAA3253fbD3184125A01f848](https://https://goerli.etherscan.io//address/0x95014Bc18F82a98CFAA3253fbD3184125A01f848)
- Bond issuer: [0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0](https://https://goerli.etherscan.io//address/0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0)
- Router: [0x5e902bdCC408550b4BD612678bE2d57677664Dc9](https://https://goerli.etherscan.io//address/0x5e902bdCC408550b4BD612678bE2d57677664Dc9)

## Contribute

To report bugs within this package, create an issue in this repository.
For security issues, please contact dev-support@ampleforth.org.
When submitting code ensure that it is free of lint errors and has 100% test coverage.

```bash
# Lint code
yarn lint:fix

# Run solidity coverage report (compatible with node v12)
yarn coverage

# Run solidity gas usage report
yarn profile
```
