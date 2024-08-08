# spot-vaults

This repository is a collection of vault strategies leveraging the SPOT system.

The official mainnet addresses are:

- Bill Broker (SPOT-USDC): [0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB](https://etherscan.io/address/0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB)
- SpotAppraiser: [0x965FBFebDA76d9AA11642C1d0074CdF02e546F3c](https://etherscan.io/address/0x965FBFebDA76d9AA11642C1d0074CdF02e546F3c)
- WethWamplManager: [0x6785fa26191eb531c54fd093931f395c4b01b583](https://etherscan.io/address/0x6785fa26191eb531c54fd093931f395c4b01b583)
- UsdcSpotManager: [0x780eB92040bf24cd9BF993505390e88E8ED59935](https://etherscan.io/address/0x780eB92040bf24cd9BF993505390e88E8ED59935)

The official testnet addresses are:

- Bill Broker (SPOT-USDC): [0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD](https://sepolia.etherscan.io/address/0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD)
- SpotAppraiser: [0x08c5b39F000705ebeC8427C1d64D6262392944EE](https://sepolia.etherscan.io/address/0x08c5b39F000705ebeC8427C1d64D6262392944EE)

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
