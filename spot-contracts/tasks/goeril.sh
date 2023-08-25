########################################################################
## DEPLOYMENT

# using staging AMPL instance deployed to: 0x08c5b39F000705ebeC8427C1d64D6262392944EE
# https://github.com/ampleforth/ampleforth-contracts

# using button wood's stating factory deployed to: 0xda5DbE504e7D532E4F8921B38E1F970D4b881BFB
# https://docs.prl.one/buttonwood/developers/deployed-contracts/goerli-testnet

yarn hardhat --network goerli deploy:BondIssuer \
  --bond-factory-address "0xdDe914EfBF5C472a590e61658d8E342d17E3AAB7" \
  --bond-duration "3600" \
  --issue-frequency "1200" \
  --issue-window-offset "0" \
  --collateral-token-address "0x08c5b39F000705ebeC8427C1d64D6262392944EE" \
  --tranche-ratios "[500,500]"

yarn hardhat --network goerli deploy:PerpetualTranche \
  --bond-issuer-address "0xbC060a1EbEC5eC869C4D51d4563244d4a223D307" \
  --collateral-token-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --name "SPOT" \
  --symbol "SPOT" \
  --pricing-strategy-ref "CDRPricingStrategy"

yarn hardhat --network goerli deploy:DiscountStrategy:setDiscount \
  --discount-strategy-address "0xEDB171C18cE90B633DB442f2A6F72874093b49Ef" \
  --collateral-token-address "0x08c5b39F000705ebeC8427C1d64D6262392944EE" \
  --tranche-ratios "[500,500]" \
  --tranche-index "0" \
  --tranche-discount "1.0"

yarn hardhat --network goerli deploy:Router

yarn hardhat --network goerli deploy:RolloverVault \
    --name "SPOT Rollover Vault Note" \
    --symbol "SPOT-RV-NOTE" \
    --perp-address "0x95014Bc18F82a98CFAA3253fbD3184125A01f848"


########################################################################
## OPS
yarn hardhat --network goerli ops:perp:info 0x95014Bc18F82a98CFAA3253fbD3184125A01f848

yarn hardhat --network goerli ops:updateState 0x95014Bc18F82a98CFAA3253fbD3184125A01f848

yarn hardhat --network goerli ops:trancheAndDeposit \
  --router-address 0x8be9cC958680A6b0AE8609150B489a161baD3dCd \
  --perp-address 0x6Da15e0ab0524841Ac5e55a77CFC3F5CB040a7B7 \
  --collateral-amount 250

yarn hardhat --network goerli ops:redeem \
  --router-address 0x8be9cC958680A6b0AE8609150B489a161baD3dCd \
  --perp-address 0x6Da15e0ab0524841Ac5e55a77CFC3F5CB040a7B7 \
  --amount 10

yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0xbC060a1EbEC5eC869C4D51d4563244d4a223D307

yarn hardhat --network goerli ops:redeemTranches \
  --bond-issuer-address 0xAb7d17864463dEdA6c19060Ad6556e1B218c5Ba0 

yarn hardhat --network goerli ops:preview_tx:trancheAndRollover \
  --wallet-address [INSERT_WALLET_ADDRESS] \
  --router-address 0x5e902bdCC408550b4BD612678bE2d57677664Dc9 \
  --perp-address 0x95014Bc18F82a98CFAA3253fbD3184125A01f848

yarn hardhat --network goerli ops:trancheAndRollover \
  --router-address 0x8be9cC958680A6b0AE8609150B489a161baD3dCd \
  --perp-address 0x6Da15e0ab0524841Ac5e55a77CFC3F5CB040a7B7 \
  --collateral-amount 200

yarn hardhat --network goerli ops:rebase:MockAMPL \
  --ampl-address "0x74567107828843070087F1c6ec8322A3e8450725" \
  --rebase-perc 0.1

yarn hardhat --network goerli ops:vault:info 0xca36B64BEbdf141623911987b93767dcA4bF6F1f

yarn hardhat --network goerli ops:vault:deposit \
  --vault-address 0xca36B64BEbdf141623911987b93767dcA4bF6F1f \
  --underlying-amount 1

yarn hardhat --network goerli ops:vault:redeem \
  --vault-address 0xca36B64BEbdf141623911987b93767dcA4bF6F1f \
  --amount 1

yarn hardhat --network goerli ops:vault:recoverAndRedeploy \
  --vault-address 0xca36B64BEbdf141623911987b93767dcA4bF6F1f

########################################################################
## upgrade

yarn hardhat --network goerli upgrade:perp:testnet 0x95014Bc18F82a98CFAA3253fbD3184125A01f848

yarn hardhat --network goerli upgrade:rolloverVault:testnet 0xca36B64BEbdf141623911987b93767dcA4bF6F1f
