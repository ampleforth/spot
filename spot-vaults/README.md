# spot-vaults

This repository is a collection of vault strategies leveraging the SPOT system.

The official mainnet addresses are:

- Bill Broker (SPOT-USDC): [0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB](https://etherscan.io/address/0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB)
- WethWamplManager: [0x574fca658b4B59E965C0e5f74761AE0Ac41DA6a7](https://etherscan.io/address/0x574fca658b4B59E965C0e5f74761AE0Ac41DA6a7)
- UsdcSpotManager: [0x2f67158859Fe0f69f5773570eC60444Fe0c1693c](https://etherscan.io/address/0x2f67158859Fe0f69f5773570eC60444Fe0c1693c)
- SpotPricer: [0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881](https://etherscan.io/address/0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881)

The official testnet addresses are:

- Bill Broker (SPOT-USDC): [0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD](https://sepolia.etherscan.io/address/0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD)
- SpotPricer: [0xc3B2C246b61123E7d18dc8d831A8314Eb038beE5](https://sepolia.etherscan.io/address/0xc3B2C246b61123E7d18dc8d831A8314Eb038beE5)

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
