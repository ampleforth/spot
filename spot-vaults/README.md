# spot-vaults

This repository is a collection of vault strategies leveraging the SPOT system.

The official mainnet addresses are:

- Bill Broker (SPOT-USDC): [0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB](https://etherscan.io/address/0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB)
- WethWamplManager: [0x6785fa26191eb531c54fd093931f395c4b01b583](https://etherscan.io/address/0x6785fa26191eb531c54fd093931f395c4b01b583)
- UsdcSpotManager: [0x780eB92040bf24cd9BF993505390e88E8ED59935](https://etherscan.io/address/0x780eB92040bf24cd9BF993505390e88E8ED59935)
- SpotPricer: [0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881](https://etherscan.io/address/0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881)

The official testnet addresses are:

- Bill Broker (SPOT-USDC): [0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD](https://sepolia.etherscan.io/address/0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD)
- SpotAppraiser **(deprecated)**: [0x08c5b39F000705ebeC8427C1d64D6262392944EE](https://sepolia.etherscan.io/address/0x08c5b39F000705ebeC8427C1d64D6262392944EE)

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
