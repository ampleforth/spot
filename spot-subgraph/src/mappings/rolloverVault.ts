import { log, ethereum } from '@graphprotocol/graph-ts'
import {
  DepositCall,
  RedeemCall,
  AssetSynced,
  SwapPerpsForUnderlyingCall,
  SwapUnderlyingForPerpsCall,
} from '../../generated/RolloverVault/RolloverVault'
import { RebasingERC20 as RebasingERC20ABI } from '../../generated/templates/RebasingToken/RebasingERC20'
import { fetchPerpetualTranche, refreshPerpetualTrancheTVL } from '../data/perpetualTranche'
import {
  fetchRolloverVault,
  fetchScaledUnderlyingVaultDepositorBalance,
  refreshRolloverVaultTVL,
  refreshRolloverVaultRebaseMultiplier,
  refreshRolloverVaultDailyStat,
  fetchRolloverVaultAsset,
  fetchRolloverVaultDailyStat,
} from '../data/rolloverVault'
import { fetchToken, refreshSupply } from '../data/token'
import {
  formatBalance,
  stringToAddress,
  addToSet,
  removeFromSet,
  BIGDECIMAL_ZERO,
  dayTimestamp,
} from '../utils'

export function handleDeposit(call: DepositCall): void {
  log.debug('triggered deposit', [])
  let vault = fetchRolloverVault(call.to)
  let vaultToken = fetchToken(stringToAddress(vault.token))
  refreshSupply(vaultToken)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  refreshSupply(underlyingToken)
  let underlyingTokenSupply = underlyingToken.totalSupply

  let underlyingTokenContract = RebasingERC20ABI.bind(stringToAddress(vault.underlying))
  let scaledUnderlyingSupply = underlyingTokenContract.scaledTotalSupply().toBigDecimal()

  let underlyingAmtIn = formatBalance(call.inputs.underlyingAmtIn, underlyingToken.decimals)
  let scaledUnderlyingAmountIn = underlyingAmtIn
    .times(scaledUnderlyingSupply)
    .div(underlyingTokenSupply)
  vault.totalScaledUnderlyingDeposited = vault.totalScaledUnderlyingDeposited.plus(
    scaledUnderlyingAmountIn,
  )
  vault.save()

  let scaledUnderlyingDepositorBalance = fetchScaledUnderlyingVaultDepositorBalance(
    vault,
    call.from,
  )
  scaledUnderlyingDepositorBalance.value = scaledUnderlyingDepositorBalance.value.plus(
    scaledUnderlyingAmountIn,
  )
  scaledUnderlyingDepositorBalance.save()

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  dailyStat.totalMints = dailyStat.totalMints.plus(underlyingAmtIn.div(vault.price))
  dailyStat.totalMintValue = dailyStat.totalMintValue.plus(underlyingAmtIn)
  dailyStat.save()
}

export function handleRedeem(call: RedeemCall): void {
  log.debug('triggered redeem', [])
  let vault = fetchRolloverVault(call.to)
  let vaultToken = fetchToken(stringToAddress(vault.token))
  refreshSupply(vaultToken)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let notesOut = formatBalance(call.inputs.notes, vaultToken.decimals)
  let scaledAmountOut = vault.totalScaledUnderlyingDeposited
    .times(notesOut)
    .div(vaultToken.totalSupply)
  vault.totalScaledUnderlyingDeposited = vault.totalScaledUnderlyingDeposited.minus(
    scaledAmountOut,
  )
  vault.save()

  let scaledUnderlyingDepositorBalance = fetchScaledUnderlyingVaultDepositorBalance(
    vault,
    call.from,
  )
  scaledUnderlyingDepositorBalance.value = scaledUnderlyingDepositorBalance.value.minus(
    scaledAmountOut,
  )
  scaledUnderlyingDepositorBalance.save()

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  dailyStat.totalRedemptions = dailyStat.totalRedemptions.plus(notesOut)
  dailyStat.totalRedemptionValue = dailyStat.totalRedemptionValue.plus(notesOut.times(vault.price))
  dailyStat.save()
}

export function handleAssetSynced(event: AssetSynced): void {
  log.debug('triggered AssetSynced', [])
  let vault = fetchRolloverVault(event.address)

  let assetToken = fetchToken(event.params.token)
  let reserveAsset = fetchRolloverVaultAsset(event.address, event.params.token)
  reserveAsset.balance = formatBalance(event.params.balance, assetToken.decimals)
  reserveAsset.save()

  let vaultAddress = event.address.toHexString()
  let reserveAssetAddress = event.params.token.toHexString()
  let activeReserveId = vaultAddress.concat('-').concat(reserveAssetAddress)

  if (reserveAsset.balance > BIGDECIMAL_ZERO) {
    vault.activeReserves = addToSet(vault.activeReserves, activeReserveId)
  } else {
    vault.activeReserves = removeFromSet(vault.activeReserves, activeReserveId)
  }
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshRolloverVaultDailyStat(dailyStat)
}

export function handleUnderlyingToPerpSwap(call: SwapUnderlyingForPerpsCall): void {
  log.debug('triggered UnderlyingToPerpSwap', [])

  let vault = fetchRolloverVault(call.to)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  let underlyingAmtIn = formatBalance(call.inputs.underlyingAmtIn, underlyingToken.decimals)

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  dailyStat.totalSwapValue = dailyStat.totalSwapValue.plus(underlyingAmtIn)
  dailyStat.totalUnderlyingToPerpSwapValue = dailyStat.totalUnderlyingToPerpSwapValue.plus(
    underlyingAmtIn,
  )
  dailyStat.save()
}

export function handlePerpToUnderlyingSwap(call: SwapPerpsForUnderlyingCall): void {
  log.debug('triggered PerpToUnderlyingSwap', [])

  let vault = fetchRolloverVault(call.to)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let perp = fetchPerpetualTranche(stringToAddress(vault.perp))
  refreshPerpetualTrancheTVL(perp)

  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  let perpAmtIn = formatBalance(call.inputs.perpAmtIn, underlyingToken.decimals)

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  dailyStat.totalSwapValue = dailyStat.totalSwapValue.plus(perpAmtIn.times(perp.price))
  dailyStat.totalPerpToUnderlyingSwapValue = dailyStat.totalPerpToUnderlyingSwapValue.plus(
    perpAmtIn.times(perp.price),
  )
  dailyStat.save()
}
