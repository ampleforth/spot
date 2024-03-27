########################################################################

## COMPILE
yarn hardhat compile

## Start network
yarn ganache-cli -p 8545 -s 123

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
  --tranche-ratios "[333,667]" \
  --verify "false"

yarn hardhat --network ganache deploy:PerpSystem \
  --bond-issuer-address "0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2" \
  --collateral-token-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --perp-name "SPOT" \
  --perp-symbol "SPOT" \
  --vault-name "Staked Ampleforth" \
  --vault-symbol "stAMPL" \
  --verify "false"

yarn hardhat --network ganache ops:perp:updateTolerableTrancheMaturity \
	--address "0x99b1445fC02b080c76AB85E5A41578e6fDF30510" \
	--minimum "300" \
	--maximum "601"

yarn hardhat --network ganache ops:fee:setSwapFees \
  --address "0x89967625335C35c5FE1F3C1c03D37fdEb6f415Ed" \
  --fee-perc "0.05"
  
yarn hardhat --network ganache deploy:Router \
	--verify "false"

########################################################################
## OPS
yarn hardhat --network ganache ops:increaseTimeBy 300
yarn hardhat --network ganache ops:rebase:MockAMPL \
  --ampl-address "0x00404F73C76BC75b0D86F8AdDA8500e987BF8232" \
  --rebase-perc 0.1

## System/INFO
yarn hardhat --network ganache ops:perp:info 0x99b1445fC02b080c76AB85E5A41578e6fDF30510
yarn hardhat --network ganache ops:vault:info 0x4741f9c161003100fF0Ba1097E149d143458bD0B

yarn hardhat --network ganache ops:perp:updateState 0x99b1445fC02b080c76AB85E5A41578e6fDF30510 
yarn hardhat --network ganache ops:vault:recoverAndRedeploy \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B

yarn hardhat --network ganache ops:vault:deploy \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B

yarn hardhat --network ganache ops:vault:recover \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B

## Perp
yarn hardhat --network ganache ops:perp:trancheAndDeposit \
  --router-address 0x704c83b179fAD95A97b12aDda5c98Fde32d258c8 \
  --perp-address 0x99b1445fC02b080c76AB85E5A41578e6fDF30510 \
  --collateral-amount 250

yarn hardhat --network ganache ops:perp:redeem \
  --router-address 0x704c83b179fAD95A97b12aDda5c98Fde32d258c8 \
  --perp-address 0x99b1445fC02b080c76AB85E5A41578e6fDF30510 \
  --amount 10

## Vault
yarn hardhat --network ganache ops:vault:deposit \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B \
  --underlying-amount 1000

yarn hardhat --network ganache ops:vault:redeem \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B \
  --amount "0.001"

yarn hardhat --network ganache ops:vault:swapUnderlyingForPerps \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B \
  --underlying-amount 10

yarn hardhat --network ganache ops:vault:swapPerpsForUnderlying \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B \
  --perp-amount 10

## Tranches
yarn hardhat --network ganache ops:redeemTranches \
  --bond-issuer-address "0xeb289644a33df897B1E30f0aa5cC0F17DD29Bdc2"

### populate
yarn hardhat --network ganache ops:increaseTimeBy 120
yarn hardhat --network ganache ops:trancheAndDeposit \
  --router-address 0x704c83b179fAD95A97b12aDda5c98Fde32d258c8 \
  --perp-address 0x99b1445fC02b080c76AB85E5A41578e6fDF30510 \
  --collateral-amount 250
yarn hardhat --network ganache ops:vault:deposit \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B \
  --underlying-amount 250
yarn hardhat --network ganache ops:vault:recoverAndRedeploy \
  --vault-address 0x4741f9c161003100fF0Ba1097E149d143458bD0B