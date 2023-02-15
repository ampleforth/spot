## Spot contracts

This repository is a collection of smart contracts that implement the SPOT perpetual note on the Ethereum blockchain.

The official mainnet addresses are:

- SPOT ERC-20 Token: [0xC1f33e0cf7e40a67375007104B929E49a581bafE](https://etherscan.io/address/0xC1f33e0cf7e40a67375007104B929E49a581bafE)
- Bond issuer: [0x85d1BA777Eb3FCBb10C82cdf3aAa8231e21B6777](https://etherscan.io/address/0x85d1BA777Eb3FCBb10C82cdf3aAa8231e21B6777)
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
- Bond issuer: [0xbC060a1EbEC5eC869C4D51d4563244d4a223D307](https://https://goerli.etherscan.io//address/0xbC060a1EbEC5eC869C4D51d4563244d4a223D307)
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
