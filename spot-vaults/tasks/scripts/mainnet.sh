########################################################################
## DEPLOYMENT

yarn hardhat --network mainnet deploy:SpotPricer \
	--weth-wampl-pool "0x0c2b6bf7322a3cceb47c7ba74f2c75a19f530f11" \
	--usdc-spot-pool "0x898adc9aa0c23dce3fed6456c34dbe2b57784325" \
	--eth-oracle "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" \
	--usd-oracle "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6"

yarn hardhat --network mainnet deploy:BillBroker \
	--name "Bill Broker USDC-SPOT LP" \
	--symbol "BB-USDC-SPOT" \
	--usd "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" \
	--perp "0xC1f33e0cf7e40a67375007104B929E49a581bafE" \
	--oracle "0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881"

yarn hardhat --network mainnet deploy:CharmManager \
	--manager "WethWamplManager" \
	--vault "0x9658B5bdCad59Dd0b7b936d955E5dF81eA2B4DcB" \
	--oracle "0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881"

yarn hardhat --network mainnet deploy:CharmManager \
	--manager "UsdcSpotManager" \
	--vault "0x2dcaff0f75765d7867887fc402b71c841b3a4bfb" \
	--oracle "0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881"

yarn hardhat --network mainnet deploy:DRBalancerVault \
	--name "DR Balancer Vault" \
	--symbol "DR-VAULT" \
	--underlying "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
	--perp "0xC1f33e0cf7e40a67375007104B929E49a581bafE" \
	--rollover-vault "0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd"

yarn hardhat --network mainnet transferOwnership "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0x574fca658b4B59E965C0e5f74761AE0Ac41DA6a7" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0x2f67158859Fe0f69f5773570eC60444Fe0c1693c" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0xd6e88D952ea0B1dFa42018c81eb597b3C1e2BF48" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0x6f60625c5B4Bdf89b9F18B9c681310E6B3dAcDbD" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

########################################################################
## INFO

yarn hardhat --network mainnet info:MetaOracle "0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881"
yarn hardhat --network mainnet info:BillBroker "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB"
yarn hardhat --network mainnet info:DRBalancerVault "0x6f60625c5B4Bdf89b9F18B9c681310E6B3dAcDbD"
yarn hardhat --network mainnet info:WethWamplManager "0x574fca658b4B59E965C0e5f74761AE0Ac41DA6a7"
yarn hardhat --network mainnet info:UsdcSpotManager "0x2f67158859Fe0f69f5773570eC60444Fe0c1693c"

########################################################################
## OPS

yarn hardhat --network mainnet ops:deposit \
	--address "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
	--perp-amount 1000 \
	--usd-amount 1000

yarn hardhat --network mainnet ops:swapUSDForPerps \
	--address "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
	--usd-amount 10

yarn hardhat --network mainnet ops:swapPerpsForUSD \
	--address "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
	--perp-amount 10

yarn hardhat --network mainnet ops:redeem \
	--address "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
	--amount 1000

yarn hardhat --network mainnet ops:drVaultDeposit \
	--address "<DR_BALANCER_VAULT_ADDRESS>" \
	--underlying-amount 1000 \
	--perp-amount 1000

yarn hardhat --network mainnet ops:drVaultRebalance \
	--address "<DR_BALANCER_VAULT_ADDRESS>"

########################################################################
## Upgrade

yarn hardhat --network mainnet validate_upgrade BillBroker "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB"
yarn hardhat --network mainnet prepare_upgrade BillBroker "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB"