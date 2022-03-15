yarn hardhat --network kovan deploy:BondFactory

yarn hardhat --network kovan deploy:BondIssuer \
  --bond-factory "0x80663156802bee89b933e66e243c717a3c538f0e" \
  --issue-frequency "21600" \
  --issue-window-offset "0" \
  --bond-duration "86400" \
  --collateral-token "0x3E0437898a5667a4769B1Ca5A34aAB1ae7E81377" \
  --tranche-ratios "[500,500]"

yarn hardhat --network kovan deploy:PerpetualTranche \
  --bond-issuer "0x7Ac3890a73556af6254c1c931104A6d362A5E5AF" \
  --name "Perpetual Safe AMPL" \
  --symbol "safeAMPL" \
  --decimals 9

yarn hardhat --network kovan deploy:PerpetualTranche:setYield \
  --perp "0x18553d37cDA8853Bc8e3D99F01F41E0d12678441" \
  --collateral-token "0x3E0437898a5667a4769B1Ca5A34aAB1ae7E81377" \
  --tranche-ratios "[500,500]" \
  --yields "[1000000,0]"

yarn hardhat --network kovan deploy:RolloverVault \
  --perp "0x18553d37cDA8853Bc8e3D99F01F41E0d12678441" \
  --underlying "0x3E0437898a5667a4769B1Ca5A34aAB1ae7E81377" \
  --name "Rollover Vault AMPL" \
  --symbol "vAMPL"

yarn hardhat --network kovan deploy:Router
