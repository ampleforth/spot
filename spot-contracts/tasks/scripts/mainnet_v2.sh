# spot v2 check storage layout
yarn hardhat --network mainnet validate_upgrade PerpetualTranche 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet validate_upgrade RolloverVault 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd

# deploy new contracts
yarn hardhat --network mainnet deploy:FeePolicy
yarn hardhat --network mainnet deploy:Router

# deploy new implementations
yarn hardhat --network mainnet prepare_upgrade PerpetualTranche 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet prepare_upgrade RolloverVault 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd

# execute via multisig
# proxyAdmin: 0x2978B4103985A6668CE345555b0febdE64Fb092F
# proxyAdmin.upgrade(0xC1f33e0cf7e40a67375007104B929E49a581bafE, 0xf4FF6a7203F91Ae72D0273DF7596a5Df5a85999b)
# proxyAdmin.upgrade(0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd, 0x9Bdba3bc5aB8EC0E895344705dC85fC29645748a)

yarn hardhat --network mainnet ops:perp:info 0xC1f33e0cf7e40a67375007104B929E49a581bafE
yarn hardhat --network mainnet ops:vault:info 0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd

# emergency rollback
# proxyAdmin.upgrade(0xC1f33e0cf7e40a67375007104B929E49a581bafE, 0xFd3171eCA94a00e40b3671803d899d3FD86c073c)
# proxyAdmin.upgrade(0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd, 0xe9f883600f875021E6B4C67Aa1D47c85763E6736)
