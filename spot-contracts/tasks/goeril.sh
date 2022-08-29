########################################################################
## DEPLOYMENT
yarn hardhat --network goerli deploy:MockAMPL

yarn hardhat --network goerli deploy:BondFactory

yarn hardhat --network goerli deploy:BondIssuer \
  --bond-factory-address "0xAcffcac91E7ca39418812BBBD50d6C6DA7Dff256" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --tranche-ratios "[500,500]"

yarn hardhat --network goerli deploy:PerpetualTranche \
  --bond-issuer-address "0xb790Fdd1a339C98aE6751Bb0D76a10FBFb3718B4" \
  --collateral-token-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --name "SPOT" \
  --symbol "SPOT" \
  --min-matuirty-sec "600" \
  --max-matuirty-sec "3600"

yarn hardhat --network goerli deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0x67d82378B5a6E78549C619E8514d97D6FE7fCCbB" \
  --collateral-token-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network goerli deploy:Router

########################################################################
## OPS
yarn hardhat --network goerli ops:info 0x0cF0bcE1d837AF29AB81eCC2F7383a175f538706

yarn hardhat --network goerli ops:trancheAndDeposit \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x0cF0bcE1d837AF29AB81eCC2F7383a175f538706 \
  --collateral-amount 250

yarn hardhat --network goerli ops:redeem \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x0cF0bcE1d837AF29AB81eCC2F7383a175f538706 \
  --amount 10

yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0xb790Fdd1a339C98aE6751Bb0D76a10FBFb3718B4 

yarn hardhat --network goerli ops:trancheAndRollover \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x0cF0bcE1d837AF29AB81eCC2F7383a175f538706 \
  --collateral-amount 200

yarn hardhat --network goerli ops:rebase:MockAMPL \
  --ampl-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --rebase-perc 0.1
