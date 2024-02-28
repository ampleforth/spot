########################################################################
## DEPLOYMENT

# using staging AMPL instance deployed to: 0x08c5b39F000705ebeC8427C1d64D6262392944EE
# https://github.com/ampleforth/ampleforth-contracts

# using button wood's stating factory deployed to: 0xda5DbE504e7D532E4F8921B38E1F970D4b881BFB
# https://docs.prl.one/buttonwood/developers/deployed-contracts/goerli-testnet

yarn hardhat --network goerli deploy:BondIssuer \
  --bond-factory-address "0x98babbD6B3CfD2542B3401B376880E8b078B8091" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0x08c5b39F000705ebeC8427C1d64D6262392944EE" \
  --tranche-ratios "[333,667]" \
  --issue true

yarn hardhat --network goerli deploy:PerpSystem \
  --bond-issuer-address "0x2844757Aa3f942b11B9290Ce044fba1663E7c322" \
  --collateral-token-address "0x08c5b39F000705ebeC8427C1d64D6262392944EE" \
  --perp-name "SPOT" \
  --perp-symbol "SPOT" \
  --vault-name "Staked Ampleforth" \
  --vault-symbol "stAMPL"

yarn hardhat --network goerli deploy:Router

yarn hardhat --network goerli ops:perp:updateTolerableTrancheMaturity \
  --address 0x941AcD21154052357302c667cfdf69a2Af0914E5 \
  --minimum 600 \
  --maximum 3600

yarn hardhat --network goerli ops:fee:setSwapFees \
  --address "0x89d619Cf7d3988cC36E96172A4227F9b5588B6BC" \
  --fee-perc "0.05"

########################################################################
## OPS
yarn hardhat --network goerli ops:perp:info 0x941AcD21154052357302c667cfdf69a2Af0914E5
yarn hardhat --network goerli ops:vault:info 0xc2f58c538D5440e54195b444B45C790316C41e32
yarn hardhat --network goerli ops:perp:updateState 0x941AcD21154052357302c667cfdf69a2Af0914E5
yarn hardhat --network goerli ops:vault:recoverAndRedeploy \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32
yarn hardhat --network goerli ops:vault:deploy \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32
yarn hardhat --network goerli ops:vault:recover \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32

yarn hardhat --network goerli ops:rebase:MockAMPL \
  --ampl-address "0x08c5b39F000705ebeC8427C1d64D6262392944EE" \
  --rebase-perc 0.1

# Perp
yarn hardhat --network goerli ops:perp:trancheAndDeposit \
  --router-address 0x175a6256562b13D3A41d0C702Af7E3859E5b53bf \
  --perp-address 0x941AcD21154052357302c667cfdf69a2Af0914E5 \
  --collateral-amount 250

yarn hardhat --network goerli ops:perp:redeem \
  --router-address 0x175a6256562b13D3A41d0C702Af7E3859E5b53bf \
  --perp-address 0x941AcD21154052357302c667cfdf69a2Af0914E5 \
  --amount 10

## Vault
yarn hardhat --network goerli ops:vault:deposit \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32 \
  --underlying-amount 250

yarn hardhat --network goerli ops:vault:redeem \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32 \
  --amount "0.001"

yarn hardhat --network goerli ops:vault:swapUnderlyingForPerps \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32 \
  --underlying-amount 10

yarn hardhat --network goerli ops:vault:swapPerpsForUnderlying \
  --vault-address 0xc2f58c538D5440e54195b444B45C790316C41e32 \
  --perp-amount 10

## Tranches
yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0x2844757Aa3f942b11B9290Ce044fba1663E7c322

########################################################################
## upgrade

yarn hardhat --network goerli upgrade:perp:testnet 0x941AcD21154052357302c667cfdf69a2Af0914E5

yarn hardhat --network goerli upgrade:rolloverVault:testnet 0xca36B64BEbdf141623911987b93767dcA4bF6F1f
