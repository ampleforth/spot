########################################################################
## DEPLOYMENT
yarn hardhat --network goerli deploy:MockAMPL

yarn hardhat --network goerli deploy:BondIssuer \
  --bond-factory-address "0xda5DbE504e7D532E4F8921B38E1F970D4b881BFB" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --tranche-ratios "[500,500]"

yarn hardhat --network goerli deploy:PerpetualTranche \
  --bond-issuer-address "0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0" \
  --collateral-token-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --name "SPOT" \
  --symbol "SPOT" \
  --pricing-strategy-ref "CDRPricingStrategy"

yarn hardhat --network goerli deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0x9649fa62f182a4922B9bb49129B20C8502027fEe" \
  --collateral-token-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network goerli deploy:Router

## verify later
yarn hardhat verify:contract --network goerli --address 0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0 --constructor-arguments "[\"0xda5DbE504e7D532E4F8921B38E1F970D4b881BFB\",1200,0,3600,\"0x74567107828843070087F1c6ec8322A3e8450725\",[500,500]]"
yarn hardhat verify:contract --network goerli --address 0x5396479b65ed39360Ba6C16f6D7c9fd357674534 --constructor-arguments "[\"0x95014Bc18F82a98CFAA3253fbD3184125A01f848\",\"0x95014Bc18F82a98CFAA3253fbD3184125A01f848\",\"1000000\",\"1000000\",\"0\"]"
yarn hardhat verify:contract --network goerli --address 0x2DdF288F26490D1147296cC0FA2B3c4da5E15f10 --constructor-arguments "[]"
yarn hardhat verify:contract --network goerli --address 0x9649fa62f182a4922B9bb49129B20C8502027fEe --constructor-arguments "[]"
yarn hardhat verify:contract --network goerli --address 0x95014Bc18F82a98CFAA3253fbD3184125A01f848 --constructor-arguments "[]"
yarn hardhat verify:contract --network goerli --address 0x5e902bdCC408550b4BD612678bE2d57677664Dc9 --constructor-arguments "[]"

########################################################################
## OPS
yarn hardhat --network goerli ops:info 0x95014Bc18F82a98CFAA3253fbD3184125A01f848

yarn hardhat --network goerli ops:trancheAndDeposit \
  --router-address 0x5e902bdCC408550b4BD612678bE2d57677664Dc9 \
  --perp-address 0x95014Bc18F82a98CFAA3253fbD3184125A01f848 \
  --collateral-amount 250

yarn hardhat --network goerli ops:redeem \
  --router-address 0x5e902bdCC408550b4BD612678bE2d57677664Dc9 \
  --perp-address 0x95014Bc18F82a98CFAA3253fbD3184125A01f848 \
  --amount 10

yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0 

yarn hardhat --network goerli ops:trancheAndRollover \
  --router-address 0x5e902bdCC408550b4BD612678bE2d57677664Dc9 \
  --perp-address 0x95014Bc18F82a98CFAA3253fbD3184125A01f848 \
  --collateral-amount 200

yarn hardhat --network goerli ops:rebase:MockAMPL \
  --ampl-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --rebase-perc 0.1


########################################################################
## upgrade

yarn hardhat --network goerli upgrade:perp:testnet 0x95014Bc18F82a98CFAA3253fbD3184125A01f848