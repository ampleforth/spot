########################################################################
## DEPLOYMENT
# monthly bonds, weekly issue, offset wednesday 2pm PST (DST)
yarn hardhat --network mainnet deploy:BondIssuer \
  --bond-factory-address "0x2b135C839d61808E1eC6F84151CD9429B0920374" \
  --bond-duration "2419200" \
  --issue-frequency "604800" \
  --issue-window-offset "597600" \
  --collateral-token-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --tranche-ratios "[200,800]"

yarn hardhat --network mainnet deploy:PerpetualTranche \
  --bond-issuer-address "0x2E2E49eDCd5ce08677Bab6d791C863f1361B52F2" \
  --collateral-token-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --name "SPOT" \
  --symbol "SPOT" \
  --pricing-strategy-ref "CDRPricingStrategy"

yarn hardhat --network mainnet deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0x2C85Fb101192e3B969c03533a3BE0b3d5f764cef" \
  --collateral-token-address "0xD46bA6D942050d489DBd938a2C909A5d5039A161" \
  --tranche-ratios "[200,800]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network mainnet deploy:Router

########################################################################
## Transfer ownership
yarn hardhat --network mainnet transferOwnership "0x2E2E49eDCd5ce08677Bab6d791C863f1361B52F2" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0xFF732cA9EFc95E853FBD71a5c61647cd0C0898a3" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0x2C85Fb101192e3B969c03533a3BE0b3d5f764cef" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0xC1f33e0cf7e40a67375007104B929E49a581bafE" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"

yarn hardhat --network mainnet transferOwnership "0x2978B4103985A6668CE345555b0febdE64Fb092F" \
  --new-owner-address "0x57981B1EaFe4b18EC97f8B10859B40207b364662"


########################################################################
## OPS
yarn hardhat --network mainnet ops:info 0xC1f33e0cf7e40a67375007104B929E49a581bafE

# test ops
yarn hardhat --network mainnet ops:updateState 0xC1f33e0cf7e40a67375007104B929E49a581bafE

yarn hardhat --network mainnet ops:trancheAndDeposit \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --collateral-amount 250

yarn hardhat --network mainnet ops:redeem \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --amount 10

yarn hardhat --network mainnet ops:redeemTranches \
  --bond-issuer-address 0x9443b779d4AedF97d2B93D7CDa5fA0BB6312DfF2

yarn hardhat --network mainnet ops:redeemTranches \
  --bond-issuer-address 0xD64FA63dc5E8fcB743457E47E4d522E11Ff1AD66

yarn hardhat --network mainnet ops:redeemTranches \
  --bond-issuer-address 0x2E2E49eDCd5ce08677Bab6d791C863f1361B52F2

yarn hardhat --network mainnet ops:preview_tx:redeemTranches \
  --wallet-address [INSERT_WALLET_ADDRESS] \
  --bond-issuer-address 0x2E2E49eDCd5ce08677Bab6d791C863f1361B52F2

yarn hardhat --network mainnet ops:preview_tx:trancheAndRollover \
  --wallet-address [INSERT_WALLET_ADDRESS] \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE

yarn hardhat --network mainnet ops:trancheAndRollover \
  --router-address 0x38f600e08540178719BF656e6B43FC15A529c393 \
  --perp-address 0xC1f33e0cf7e40a67375007104B929E49a581bafE \
  --collateral-amount 200

########################################################################
## upgrade

yarn hardhat --network mainnet prepare_upgrade:perp:mainnet 0xC1f33e0cf7e40a67375007104B929E49a581bafE
