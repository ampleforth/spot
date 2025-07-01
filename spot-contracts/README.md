## Spot contracts

This repository is a collection of smart contracts that implement the SPOT perpetual note on the Ethereum blockchain.

The official mainnet addresses are:

- SPOT ERC-20 Token: [0xC1f33e0cf7e40a67375007104B929E49a581bafE](https://etherscan.io/address/0xC1f33e0cf7e40a67375007104B929E49a581bafE)
- Bond issuer: [0x5613Fc36A431c9c2746763B80C1DD89e03593871](https://etherscan.io/address/0x5613Fc36A431c9c2746763B80C1DD89e03593871)
- Router: [0xCe2878d1f2901EFaF48cd456E586B470C145d1BC](https://etherscan.io/address/0xCe2878d1f2901EFaF48cd456E586B470C145d1BC)
- RolloverVault: [0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd](https://etherscan.io//address/0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd)
- FeePolicy: [0x8689Fa9991834Bcf0387b31b7986ac311bAb6ab5](https://etherscan.io//address/0x8689Fa9991834Bcf0387b31b7986ac311bAb6ab5)

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
- Router: [0xE5b53ee8182086790C1ab79cbf801F0c5EE241BF](https://sepolia.etherscan.io//address/0xE5b53ee8182086790C1ab79cbf801F0c5EE241BF)
- RolloverVault: [0x107614c6602A8e602952Da107B8fE62b5Ab13b04](https://sepolia.etherscan.io//address/0x107614c6602A8e602952Da107B8fE62b5Ab13b04)
- FeePolicy: [0xd90FcB328D90B778D1f6719d781045bbbac8F251](https://sepolia.etherscan.io//address/0xd90FcB328D90B778D1f6719d781045bbbac8F251)

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
