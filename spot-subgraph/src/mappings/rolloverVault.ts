import { log, ethereum } from '@graphprotocol/graph-ts'
import {
  DepositCall,
  RedeemCall,
  AssetSynced,
} from '../../generated/RolloverVault/RolloverVault'
import { RebasingERC20 as RebasingERC20ABI } from '../../generated/templates/RebasingToken/RebasingERC20'
import {
  fetchRolloverVault,
  fetchScaledUnderlyingVaultBalance,
  refreshRolloverVaultStore,
  fetchRolloverVaultAsset,
} from '../data/rolloverVault'
import { fetchToken } from '../data/token'
import { formatBalance, stringToAddress } from '../utils'

export function handleGenericStorageUpdateViaEvent(
  event: ethereum.Event,
): void {
  log.debug('triggered handleGenericStorageUpdate', [])
  refreshRolloverVaultStore(fetchRolloverVault(event.address))
}

export function handleGenericStorageUpdateViaCall(call: ethereum.Call): void {
  log.debug('triggered handleGenericStorageUpdate', [])
  refreshRolloverVaultStore(fetchRolloverVault(call.to))
}

export function handleDeposit(call: DepositCall): void {
  log.debug('triggered deposit', [])
  let vault = fetchRolloverVault(call.to)
  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  let tokenContract = RebasingERC20ABI.bind(stringToAddress(vault.underlying))
  let amountIn = formatBalance(call.inputs.amount, underlyingToken.decimals)
  let totalSupply = formatBalance(
    tokenContract.totalSupply(),
    underlyingToken.decimals,
  )
  let scaledTotalSupply = tokenContract.scaledTotalSupply().toBigDecimal()
  let scaledAmountIn = amountIn.times(scaledTotalSupply).div(totalSupply)
  vault.totalUnderlyingScaledHeld = vault.totalUnderlyingScaledHeld.plus(
    scaledAmountIn,
  )
  vault.save()

  let userBalance = fetchScaledUnderlyingVaultBalance(vault, call.from)
  userBalance.value = userBalance.value.plus(scaledAmountIn)
  userBalance.save()
}

export function handleRedeem(call: RedeemCall): void {
  log.debug('triggered redeem', [])
  let vault = fetchRolloverVault(call.to)
  let vaultToken = fetchToken(stringToAddress(vault.token))
  let tokenContract = RebasingERC20ABI.bind(stringToAddress(vault.underlying))
  let notesOut = formatBalance(call.inputs.notes, vaultToken.decimals)
  let scaledAmountOut = vault.totalUnderlyingScaledHeld
    .times(notesOut)
    .div(vaultToken.totalSupply)
  vault.totalUnderlyingScaledHeld = vault.totalUnderlyingScaledHeld.minus(
    scaledAmountOut,
  )
  vault.save()

  let userBalance = fetchScaledUnderlyingVaultBalance(vault, call.from)
  userBalance.value = userBalance.value.minus(scaledAmountOut)
  userBalance.save()
}

export function handleAssetSynced(event: AssetSynced): void {
  log.debug('triggered AssetSynced', [])
  let vault = fetchRolloverVault(event.address)
  let assetToken = fetchToken(event.params.token)
  let reserveAsset = fetchRolloverVaultAsset(event.address, event.params.token)
  reserveAsset.balance = formatBalance(
    event.params.balance,
    assetToken.decimals,
  )
  reserveAsset.save()
}
