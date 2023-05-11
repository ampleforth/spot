########################################################################

## COMPILE
yarn hardhat compile

## DEPLOYMENT

yarn hardhat --network ganache deploy:MockAMPL \
	--verify "false"

yarn hardhat --network ganache deploy:BondFactory \
	--verify "false"

yarn hardhat --network ganache deploy:BondIssuer \
  --bond-factory-address "0x25a02122Cd77FeB7981b6224b470111A8FA479F4" \
  --bond-duration "600" \
  --issue-frequency "60" \
  --issue-window-offset "0" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --tranche-ratios "[500,500]" \
  --verify "false"

yarn hardhat --network ganache deploy:PerpetualTranche \
  --bond-issuer-address "0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --name "SPOT" \
  --symbol "SPOT" \
  --verify "false"

yarn hardhat --network ganache deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0xeEaC7F8841B8E4Aa4D9E63164227a4788dF6dC99" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network ganache ops:perp:updateTolerableTrancheMaturity \
	--address "0xC090cFC721ea0624A30BE6796A53CE1EEf703D67" \
	--minimum "500" \
	--maximum "1000"

yarn hardhat --network ganache deploy:Router \
	--verify "false"

yarn hardhat --network ganache deploy:RolloverVault \
    --name "SPOT Rollover Vault Note" \
    --symbol "SPOT-RV-NOTE" \
    --perp-address "0xC090cFC721ea0624A30BE6796A53CE1EEf703D67" \
	--verify "false"

########################################################################
## OPS
yarn hardhat --network ganache ops:increaseTimeBy 300
yarn hardhat --network ganache ops:updateState 0xC090cFC721ea0624A30BE6796A53CE1EEf703D67 
yarn hardhat --network ganache ops:perp:info 0xC090cFC721ea0624A30BE6796A53CE1EEf703D67

