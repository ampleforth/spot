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

yarn hardhat --network goerli deploy:YieldStrategy:setYield \
  --yield-strategy-address "0xA8F366602BC0dd45EC191616BCaF4147cb9263B0" \
  --collateral-token-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-yield "1.0"

yarn hardhat --network goerli deploy:Router

########################################################################
## OPS
yarn hardhat --network goerli ops:info 0x534e2cA3Ce918321BDd6F151B7D1A0f8832Ab1c6

yarn hardhat --network goerli ops:trancheAndDeposit \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x534e2cA3Ce918321BDd6F151B7D1A0f8832Ab1c6 \
  --collateral-amount 250

yarn hardhat --network goerli ops:redeem \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x534e2cA3Ce918321BDd6F151B7D1A0f8832Ab1c6 \
  --amount 10

yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0xb790Fdd1a339C98aE6751Bb0D76a10FBFb3718B4 

yarn hardhat --network goerli ops:trancheAndRollover \
  --router-address 0x948e4869fAEF267406F896290209Ca229cFAF220 \
  --perp-address 0x534e2cA3Ce918321BDd6F151B7D1A0f8832Ab1c6 \
  --collateral-amount 200


yarn hardhat --network goerli ops:rebase:MockAMPL \
  --ampl-address "0x14f6e47F3237213E4B7E1dAEc273545df524039F" \
  --rebase-perc 0.1
