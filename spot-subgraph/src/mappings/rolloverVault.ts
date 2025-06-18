import { log, ethereum } from '@graphprotocol/graph-ts'
import {
  Transfer,
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
  refreshRolloverVaultTVL,
  refreshRolloverVaultRebaseMultiplier,
  refreshRolloverVaultDailyStat,
  fetchRolloverVaultAsset,
  fetchRolloverVaultDailyStat,
  computeFeePerc,
} from '../data/rolloverVault'
import { fetchToken, refreshSupply } from '../data/token'
import {
  formatBalance,
  stringToAddress,
  addToSet,
  removeFromSet,
  BIGDECIMAL_ZERO,
  dayTimestamp,
  ADDRESS_ZERO,
} from '../utils'

export function handleTransfer(event: Transfer): void {
  let from = event.params.from
  let to = event.params.to
  if (from == ADDRESS_ZERO) {
    log.debug('triggered mint', [])
    let vault = fetchRolloverVault(event.address)
    let vaultToken = fetchToken(event.address)
    refreshSupply(vaultToken)
    refreshRolloverVaultTVL(vault)
    refreshRolloverVaultRebaseMultiplier(vault)
  }

  if (to == ADDRESS_ZERO) {
    log.debug('triggered burn', [])
    let vault = fetchRolloverVault(event.address)
    let vaultToken = fetchToken(event.address)
    refreshSupply(vaultToken)
    refreshRolloverVaultTVL(vault)
    refreshRolloverVaultRebaseMultiplier(vault)
  }
}

export function handleDeposit(call: DepositCall): void {
  log.debug('triggered deposit', [])
  let vault = fetchRolloverVault(call.to)
  let vaultAddress = stringToAddress(vault.token)
  let perp = fetchPerpetualTranche(stringToAddress(vault.perp))
  let underlyingToken = fetchToken(stringToAddress(vault.underlying))

  let underlyingAmtIn = formatBalance(call.inputs.underlyingAmtIn, underlyingToken.decimals)
  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  let feePerc = computeFeePerc(
    perp.tvl,
    vault.tvl.minus(underlyingAmtIn),
    perp.tvl,
    vault.tvl,
    vault.targetSystemRatio,
    vaultAddress,
  )
  dailyStat.totalUnderlyingFeeValue = dailyStat.totalUnderlyingFeeValue.plus(
    underlyingAmtIn.times(feePerc),
  )
  dailyStat.save()
}

export function handleRedeem(call: RedeemCall): void {
  log.debug('triggered redeem', [])
  let vault = fetchRolloverVault(call.to)
  let vaultAddress = stringToAddress(vault.token)
  let vaultToken = fetchToken(vaultAddress)
  let perp = fetchPerpetualTranche(stringToAddress(vault.perp))

  let notesOut = formatBalance(call.inputs.notes, vaultToken.decimals)
  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  let feePerc = computeFeePerc(
    perp.tvl,
    vault.tvl.times(notesOut + vaultToken.totalSupply).div(vaultToken.totalSupply),
    perp.tvl,
    vault.tvl,
    vault.targetSystemRatio,
    vaultAddress,
  )
  dailyStat.totalUnderlyingFeeValue = dailyStat.totalUnderlyingFeeValue.plus(
    notesOut.times(vault.price).times(feePerc),
  )
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
  let vaultAddress = stringToAddress(vault.token)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let perp = fetchPerpetualTranche(stringToAddress(vault.perp))
  refreshPerpetualTrancheTVL(perp)

  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  let underlyingAmtIn = formatBalance(call.inputs.underlyingAmtIn, underlyingToken.decimals)

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  let feePerc = computeFeePerc(
    perp.tvl.minus(underlyingAmtIn),
    vault.tvl,
    perp.tvl,
    vault.tvl,
    vault.targetSystemRatio,
    vaultAddress,
  )
  log.error('computing fee {}:{}:{}:{}', [
    perp.tvl.minus(underlyingAmtIn).toString(),
    vault.tvl.toString(),
    perp.tvl.toString(),
    vault.tvl.toString(),
    vault.targetSystemRatio.toString(),
  ])
  dailyStat.totalUnderlyingFeeValue = dailyStat.totalUnderlyingFeeValue.plus(
    underlyingAmtIn.times(feePerc),
  )

  dailyStat.save()
}

export function handlePerpToUnderlyingSwap(call: SwapPerpsForUnderlyingCall): void {
  log.debug('triggered PerpToUnderlyingSwap', [])

  let vault = fetchRolloverVault(call.to)
  let vaultAddress = stringToAddress(vault.token)
  refreshRolloverVaultTVL(vault)
  refreshRolloverVaultRebaseMultiplier(vault)

  let perp = fetchPerpetualTranche(stringToAddress(vault.perp))
  refreshPerpetualTrancheTVL(perp)

  let underlyingToken = fetchToken(stringToAddress(vault.underlying))
  let perpAmtIn = formatBalance(call.inputs.perpAmtIn, underlyingToken.decimals)

  let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(call.block.timestamp))
  let feePerc = computeFeePerc(
    perp.tvl.plus(perpAmtIn.times(perp.price)),
    vault.tvl,
    perp.tvl,
    vault.tvl,
    vault.targetSystemRatio,
    vaultAddress,
  )
  dailyStat.totalUnderlyingFeeValue = dailyStat.totalUnderlyingFeeValue.plus(
    perpAmtIn.times(perp.price).times(feePerc),
  )

  dailyStat.save()
}
