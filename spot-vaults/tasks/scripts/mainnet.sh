########################################################################
## DEPLOYMENT

yarn hardhat --network mainnet deploy:SpotAppraiser \
	--perp "0xC1f33e0cf7e40a67375007104B929E49a581bafE" \
	--usd-oracle "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6" \
	--cpi-oracle "0x2A18bfb505b49AED12F19F271cC1183F98ff4f71"

yarn hardhat --network mainnet deploy:BillBroker \
	--name "Bill Broker USDC-SPOT LP" \
	--symbol "BB-USDC-SPOT" \
	--usd "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" \
	--perp "0xC1f33e0cf7e40a67375007104B929E49a581bafE" \
	--pricing-strategy "0x965FBFebDA76d9AA11642C1d0074CdF02e546F3c"

yarn hardhat --network mainnet transferOwnership "0x965FBFebDA76d9AA11642C1d0074CdF02e546F3c" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0xF6E42F7a83fCfB1Bd28aC209fD4a849f54bD1044" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet deploy:WethWamplManager \
	--vault "0x9658B5bdCad59Dd0b7b936d955E5dF81eA2B4DcB" \
	--cpi-oracle "0x2A18bfb505b49AED12F19F271cC1183F98ff4f71" \
	--eth-oracle "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"

yarn hardhat --network mainnet transferOwnership "0x803094e6427c0bd10398236433F6c18B7aBf98ab" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

########################################################################
## INFO

yarn hardhat --network mainnet info:BillBroker "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB"
yarn hardhat --network mainnet info:WethWamplManager "0x803094e6427c0bd10398236433F6c18B7aBf98ab"

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