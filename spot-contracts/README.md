## Spot contracts

This repository is a collection of smart contracts that implement the SPOT perpetual note on the Ethereum blockchain.

The official mainnet addresses are:

- SPOT ERC-20 Token: [0xC1f33e0cf7e40a67375007104B929E49a581bafE](https://etherscan.io/address/0xC1f33e0cf7e40a67375007104B929E49a581bafE)
- Bond issuer: [0x5613Fc36A431c9c2746763B80C1DD89e03593871](https://etherscan.io/address/0x5613Fc36A431c9c2746763B80C1DD89e03593871)
- Router: [0x38f600e08540178719BF656e6B43FC15A529c393](https://etherscan.io/address/0x38f600e08540178719BF656e6B43FC15A529c393)
- RolloverVault: [0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd](https://etherscan.io//address/0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd)

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

There is a testnet deployment on Sepolia.

- SPOT ERC-20 Token: [0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F](https://sepolia.etherscan.io//address/0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F)
- Bond issuer: [0x3838C8d4D092d40Cb27DD22Dafc6E1A81ea2DB60](https://sepolia.etherscan.io//address/0x3838C8d4D092d40Cb27DD22Dafc6E1A81ea2DB60)
- Router: [0x5B59915E5754C62C40Ba5e7467382ced958F8559](https://sepolia.etherscan.io//address/0x5B59915E5754C62C40Ba5e7467382ced958F8559)
- RolloverVault: [0x107614c6602A8e602952Da107B8fE62b5Ab13b04](https://sepolia.etherscan.io//address/0x107614c6602A8e602952Da107B8fE62b5Ab13b04)
- FeePolicy: [0x2DdF288F26490D1147296cC0FA2B3c4da5E15f10](https://sepolia.etherscan.io//address/0x2DdF288F26490D1147296cC0FA2B3c4da5E15f10)

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
