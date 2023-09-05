import { BigInt, Address, DataSourceContext } from '@graphprotocol/graph-ts'
import {
  RolloverVault,
  RolloverVaultAsset,
  ScaledUnderlyingVaultBalance,
} from '../../generated/schema'
import { RolloverVault as RolloverVaultABI } from '../../generated/RolloverVault/RolloverVault'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import { RebasingToken as RebasingTokenTemplate } from '../../generated/templates'
import {
  ADDRESS_ZERO,
  BIGDECIMAL_ZERO,
  stringToAddress,
  formatBalance,
} from '../utils'
import { fetchPerpetualTranche } from './perpetualTranche'
import { fetchToken } from './token'

export function refreshRolloverVaultStore(vault: RolloverVault): void {
  let address = stringToAddress(vault.id)
  let vaultContract = RolloverVaultABI.bind(address)
  let decimals = BigInt.fromI32(vaultContract.decimals())

  let underlyingAddress = vaultContract.underlying()
  let underlying = fetchToken(underlyingAddress)
  vault.underlying = underlying.id

  let perpAddress = vaultContract.perp()
  let perp = fetchPerpetualTranche(perpAddress)
  vault.perp = perp.id

  vault.owner = vaultContract.owner().toHexString()
  vault.save()

  let underlyingContract = ERC20ABI.bind(underlyingAddress)
  let underlyingAsset = fetchRolloverVaultAsset(address, underlyingAddress)
  underlyingAsset.balance = formatBalance(
    underlyingContract.balanceOf(address),
    decimals,
  )
  underlyingAsset.save()
}

export function fetchRolloverVault(address: Address): RolloverVault {
  let id = address.toHexString()
  let vault = RolloverVault.load(id)
  if (vault == null) {
    let vaultToken = fetchToken(address)
    vault = new RolloverVault(id)
    vault.token = vaultToken.id
    vault.totalUnderlyingScaledHeld = BIGDECIMAL_ZERO
    refreshRolloverVaultStore(vault as RolloverVault)

    let underlyingContext = new DataSourceContext()
    underlyingContext.setString('vault', id)
    RebasingTokenTemplate.createWithContext(
      stringToAddress(vault.underlying),
      underlyingContext,
    )
    vault.save()
  }

  return vault as RolloverVault
}

export function fetchRolloverVaultAsset(
  vaultAddress: Address,
  tokenAddress: Address,
): RolloverVaultAsset {
  let vaultId = vaultAddress.toHexString()
  let tokenId = tokenAddress.toHexString()
  let id = vaultId.concat('-').concat(tokenId)
  let assetToken = RolloverVaultAsset.load(id)
  if (assetToken === null) {
    let vaultContract = RolloverVaultABI.bind(vaultAddress)
    let underlyingAddress = vaultContract.underlying()
    let perpAddress = vaultContract.perp()
    assetToken = new RolloverVaultAsset(id)
    assetToken.vault = vaultId
    assetToken.token = tokenId
    assetToken.balance = BIGDECIMAL_ZERO
    // if the vault asset isn't perp or the underlying, we infer its a tranche
    if (tokenAddress != underlyingAddress && tokenAddress != perpAddress) {
      assetToken.tranche = tokenId
    }
    assetToken.save()
  }
  return assetToken as RolloverVaultAsset
}

export function fetchScaledUnderlyingVaultBalance(
  vault: RolloverVault,
  account: Address,
): ScaledUnderlyingVaultBalance {
  let id = vault.id.concat('|').concat(account.toHexString())
  let balance = ScaledUnderlyingVaultBalance.load(id)
  if (balance == null) {
    balance = new ScaledUnderlyingVaultBalance(id)
    balance.vault = vault.id
    balance.account = account
    balance.value = BIGDECIMAL_ZERO
  }
  return balance as ScaledUnderlyingVaultBalance
}
