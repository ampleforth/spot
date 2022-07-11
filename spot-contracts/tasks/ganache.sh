yarn run ganache-cli -s 123

yarn hardhat --network ganache deploy:MockAMPL

yarn hardhat --network ganache ops:rebase:MockAMPL \
  --ampl-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --rebase-perc 0.1

yarn hardhat --network ganache deploy:BondFactory

yarn hardhat --network ganache deploy:BondIssuer \
  --bond-factory-address "0x25a02122Cd77FeB7981b6224b470111A8FA479F4" \
  --bond-duration "600" \
  --issue-frequency "60" \
  --issue-window-offset "0" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --tranche-ratios "[500,500]"

yarn hardhat --network ganache deploy:PerpetualTranche \
  --bond-issuer-address "0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --name "SPOT" \
  --symbol "SPOT" \
  --min-matuirty-sec "300" \
  --max-matuirty-sec "600"

yarn hardhat --network ganache deploy:YieldStrategy:setYield \
  --yield-strategy-address "0x0fB005B5BA04BCD5438EF80af2Ba401706712D2a" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-yield "1.0"

yarn hardhat --network ganache deploy:Router

yarn hardhat --network ganache ops:info 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed

yarn hardhat --network ganache ops:trancheAndDeposit \
  --router-address 0xc9130ad8c7f54a15338fBa0E78aF5B7546F1a2Ac \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --collateral-amount 250

yarn hardhat --network ganache ops:redeem \
  --router-address 0xc9130ad8c7f54a15338fBa0E78aF5B7546F1a2Ac \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --amount 10

yarn hardhat --network ganache ops:redeemTranches \
  --bond-issuer-address 0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2 

yarn hardhat --network ganache ops:trancheAndRollover \
  --router-address 0xc9130ad8c7f54a15338fBa0E78aF5B7546F1a2Ac \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --collateral-amount 200

yarn hardhat --network ganache ops:increaseTimeBy 60