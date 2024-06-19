########################################################################
## DEPLOYMENT

yarn hardhat --network sepolia deploy:mocks

yarn hardhat --network sepolia deploy:SpotAppraiser \
	--perp "0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F" \
	--usd-oracle "0x69782f8aAFD49EC3818C1427F094821759310b4b" \
	--cpi-oracle "0xbB65d97f9222109Fea38923705B4Fe3dE43DA546"

yarn hardhat --network sepolia deploy:BillBroker \
	--name "Bill Broker USDC-SPOT LP" \
	--symbol "BB-USDC-SPOT" \
	--usd "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8" \
	--perp "0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F" \
	--pricing-strategy "0x9e8EaF8B24B34BBA28dB7D4Ce8858c6c1F82fE68"

########################################################################
## INFO

yarn hardhat --network sepolia info:BillBroker "0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD"

########################################################################
## OPS

yarn hardhat --network sepolia mock:UsdPrice "0x69782f8aAFD49EC3818C1427F094821759310b4b"

yarn hardhat --network sepolia ops:deposit \
	--address "0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD" \
	--perp-amount 1000 \
	--usd-amount 1000

yarn hardhat --network sepolia ops:swapUSDForPerps \
	--address "0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD" \
	--usd-amount 10

yarn hardhat --network sepolia ops:swapPerpsForUSD \
	--address "0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD" \
	--perp-amount 10

yarn hardhat --network sepolia ops:redeem \
	--address "0xc3f6D1F1d253EdC8B34D78Bc6cDD2b3eEFAd76BD" \
	--amount 1000