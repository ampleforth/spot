########################################################################
## DEPLOYMENT

yarn hardhat --network sepolia deploy:MockAMPL --verify "false"

yarn hardhat --network sepolia deploy:BondFactory --verify "false"

yarn hardhat --network sepolia deploy:BondIssuer \
  --bond-factory-address "0x25BcaEd6377CEAA345f12C2005a42e669B8a29fC" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0x251410f849ad67bebffdb5a549e5f02d5d9c25ba" \
  --tranche-ratios "[333,667]" \
  --issue true

yarn hardhat --network sepolia deploy:PerpSystem \
  --bond-issuer-address "0x3838C8d4D092d40Cb27DD22Dafc6E1A81ea2DB60" \
  --collateral-token-address "0x251410f849ad67bebffdb5a549e5f02d5d9c25ba" \
  --perp-name "SPOT" \
  --perp-symbol "SPOT" \
  --vault-name "Staked Ampleforth" \
  --vault-symbol "stAMPL"

yarn hardhat --network sepolia deploy:Router

yarn hardhat --network sepolia ops:perp:updateTolerableTrancheMaturity \
  --address 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F \
  --minimum 600 \
  --maximum 3600

yarn hardhat --network sepolia ops:fee:setSwapFees \
  --address "0x2DdF288F26490D1147296cC0FA2B3c4da5E15f10" \
  --fee-perc "0.05"

########################################################################
## OPS
yarn hardhat --network sepolia ops:perp:info 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F
yarn hardhat --network sepolia ops:vault:info 0x107614c6602A8e602952Da107B8fE62b5Ab13b04
yarn hardhat --network sepolia ops:perp:updateState 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F
yarn hardhat --network sepolia ops:vault:recoverAndRedeploy \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04
yarn hardhat --network sepolia ops:vault:deploy \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04
yarn hardhat --network sepolia ops:vault:recover \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04

yarn hardhat --network sepolia ops:rebase:MockAMPL \
  --ampl-address "0x251410f849ad67bebffdb5a549e5f02d5d9c25ba" \
  --rebase-perc 0.1

# Perp
yarn hardhat --network sepolia ops:perp:trancheAndDeposit \
  --router-address 0x5B59915E5754C62C40Ba5e7467382ced958F8559 \
  --perp-address 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F \
  --collateral-amount 250

yarn hardhat --network sepolia ops:perp:redeem \
  --router-address 0x5B59915E5754C62C40Ba5e7467382ced958F8559 \
  --perp-address 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F \
  --amount 10

## Vault
yarn hardhat --network sepolia ops:vault:deposit \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04 \
  --underlying-amount 250

yarn hardhat --network sepolia ops:vault:redeem \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04 \
  --amount "0.001"

yarn hardhat --network sepolia ops:vault:swapUnderlyingForPerps \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04 \
  --underlying-amount 10

yarn hardhat --network sepolia ops:vault:swapPerpsForUnderlying \
  --vault-address 0x107614c6602A8e602952Da107B8fE62b5Ab13b04 \
  --perp-amount 10

## Tranches
yarn hardhat --network sepolia ops:redeemTranches \
  --bond-issuer-address 0x3838C8d4D092d40Cb27DD22Dafc6E1A81ea2DB60

########################################################################
## upgrade
yarn hardhat --network sepolia validate_upgrade PerpetualTranche 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F
yarn hardhat --network sepolia validate_upgrade RolloverVault 0x107614c6602A8e602952Da107B8fE62b5Ab13b04

yarn hardhat --network sepolia prepare_upgrade PerpetualTranche 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F
yarn hardhat --network sepolia prepare_upgrade RolloverVault 0x107614c6602A8e602952Da107B8fE62b5Ab13b04

yarn hardhat --network sepolia upgrade:testnet PerpetualTranche 0xdcCef9065876fD654bAddeBAa778FDA43E0bfC1F
yarn hardhat --network sepolia upgrade:testnet RolloverVault 0x107614c6602A8e602952Da107B8fE62b5Ab13b04
