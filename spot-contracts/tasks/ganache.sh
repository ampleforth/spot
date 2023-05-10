yarn run ganache-cli -s 123

########################################################################
## DEPLOYMENT
yarn hardhat --network ganache deploy:MockAMPL

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
  --pricing-strategy-ref "CDRPricingStrategy"

yarn hardhat --network ganache deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0x4741f9c161003100fF0Ba1097E149d143458bD0B" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network ganache deploy:Router

########################################################################
## OPS

yarn hardhat --network ganache ops:perp:info 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed

yarn hardhat --network ganache ops:trancheAndDeposit \
  --router-address 0x4a57d51af3a8a90905a5F756E0B28cC2888A1bD5 \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --collateral-amount 200

yarn hardhat --network ganache ops:redeem \
  --router-address 0x4a57d51af3a8a90905a5F756E0B28cC2888A1bD5 \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --amount 10

yarn hardhat --network ganache ops:redeemTranches \
  --bond-issuer-address 0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2 

yarn hardhat --network ganache ops:trancheAndRollover \
  --router-address 0x4a57d51af3a8a90905a5F756E0B28cC2888A1bD5 \
  --perp-address 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed \
  --collateral-amount 200

yarn hardhat --network ganache ops:increaseTimeBy 300
yarn hardhat --network ganache ops:updateState 0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed

yarn hardhat --network ganache ops:rebase:MockAMPL \
  --ampl-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --rebase-perc 0.05

########################################################################
