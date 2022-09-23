########################################################################
## DEPLOYMENT
yarn hardhat --network mainnet deploy:BondIssuer \
  --bond-factory-address "0x019fa32d71bb96922695c6cdea33774fdeb04ac0" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --tranche-ratios "[500,500]"

yarn hardhat --network mainnet deploy:PerpetualTranche \
  --bond-issuer-address "0xf41Cdfaae972Fde08c50594D452DFDd9dE94Eabc" \
  --collateral-token-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --name "SPOT" \
  --symbol "SPOT" \
  --pricing-strategy-ref "CDRPricingStrategy"

yarn hardhat --network mainnet deploy:Router

## verify & configure later
yarn hardhat verify:contract --network mainnet --address 0xf41Cdfaae972Fde08c50594D452DFDd9dE94Eabc --constructor-arguments "[\"0x019fa32d71bb96922695c6cdea33774fdeb04ac0\",1200,0,3600,\"0xD46bA6D942050d489DBd938a2C909A5d5039A161\",[500,500]]"
yarn hardhat verify:contract --network mainnet --address 0xFF732cA9EFc95E853FBD71a5c61647cd0C0898a3 --constructor-arguments "[\"0xC1f33e0cf7e40a67375007104B929E49a581bafE\",\"0xC1f33e0cf7e40a67375007104B929E49a581bafE\",\"1000000\",\"1000000\",\"0\"]"
yarn hardhat verify:contract --network mainnet --address 0x437ef588307A6E1367E29283edB1740A8b5CBeAA --constructor-arguments "[]"
yarn hardhat verify:contract --network mainnet --address 0x2C85Fb101192e3B969c03533a3BE0b3d5f764cef --constructor-arguments "[]"
yarn hardhat verify:contract --network mainnet --address 0xC1f33e0cf7e40a67375007104B929E49a581bafE --constructor-arguments "[]"
yarn hardhat verify:contract --network mainnet --address 0x38f600e08540178719BF656e6B43FC15A529c393 --constructor-arguments "[]"
########################################################################
## OPS
yarn hardhat --network mainnet ops:info 0xC1f33e0cf7e40a67375007104B929E49a581bafE

# test ops
yarn hardhat --network mainnet ops:trancheAndDeposit \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --collateral-amount 250

yarn hardhat --network mainnet ops:redeem \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --amount 10

yarn hardhat --network mainnet ops:redeemTranches \
  --bond-issuer-address 0xf41Cdfaae972Fde08c50594D452DFDd9dE94Eabc 

yarn hardhat --network mainnet ops:trancheAndRollover \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --collateral-amount 200

yarn hardhat --network mainnet ops:rebase:MockAMPL \
  --ampl-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --rebase-perc 0.1
