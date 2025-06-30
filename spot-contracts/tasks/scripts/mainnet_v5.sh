# deploy new contracts
yarn hardhat --network mainnet deploy:FeePolicy

# spot v2 check storage layout
yarn hardhat --network mainnet validate_upgrade PerpetualTranche 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet validate_upgrade:RolloverVault 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd \
	--tranche-manager-address 0xe0028c40C8A09449852ea4D2e9aa4d25895F285f

# deploy new implementations
yarn hardhat --network mainnet prepare_upgrade PerpetualTranche 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet prepare_upgrade:RolloverVault 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd
# linked library 0xe0028c40C8A09449852ea4D2e9aa4d25895F285f

# execute via multisig
# proxyAdmin: 0x2978B4103985A6668CE345555b0febdE64Fb092F
# proxyAdmin.upgrade(0xC1f33e0cf7e40a67375007104B929E49a581bafE, 0x62cbE9F24413485f04FA62F9548C7855ec4a5425)
# proxyAdmin.upgrade(0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd, 0xA85Be82083E032EdF32a19028DF558484b399196)

yarn hardhat --network mainnet ops:perp:info 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet ops:vault:info 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd

# emergency rollback
# proxyAdmin.upgrade(0xC1f33e0cf7e40a67375007104B929E49a581bafE, 0x5dc5488b35c34a43fe19ba9de38b63806fab4b23)
# proxyAdmin.upgrade(0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd, 0xa85be82083e032edf32a19028df558484b399196)
