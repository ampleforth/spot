import { log, ethereum, BigInt } from '@graphprotocol/graph-ts'
import {
  ReserveSynced,
  UpdatedDepositBond,
  Transfer,
  RedeemCall,
} from '../../generated/PerpetualTranche/PerpetualTranche'
import {
  fetchPerpetualTranche,
  refreshPerpetualTrancheTVL,
  refreshPerpetualTrancheDailyStat,
  fetchPerpetualTrancheReserveAsset,
  fetchPerpetualTrancheDailyStat,
} from '../data/perpetualTranche'
import { fetchBond } from '../data/buttonTranche'
import { fetchToken, refreshSupply } from '../data/token'
import {
  formatBalance,
  addToSet,
  removeFromSet,
  BIGDECIMAL_ZERO,
  ADDRESS_ZERO,
  dayTimestamp,
} from '../utils'

export function handleReserveSynced(event: ReserveSynced): void {
  log.debug('triggered handleReserveSynced', [])

  let perp = fetchPerpetualTranche(event.address)

  let reserveToken = fetchToken(event.params.token)
  let reserveAsset = fetchPerpetualTrancheReserveAsset(event.address, event.params.token)
  reserveAsset.balance = formatBalance(event.params.balance, reserveToken.decimals)
  reserveAsset.save()

  let perpAddress = event.address.toHexString()
  let reserveAssetAddress = event.params.token.toHexString()
  let activeReserveId = perpAddress.concat('-').concat(reserveAssetAddress)

  if (reserveAsset.balance > BIGDECIMAL_ZERO) {
    perp.activeReserves = addToSet(perp.activeReserves, activeReserveId)
  } else {
    perp.activeReserves = removeFromSet(perp.activeReserves, activeReserveId)
  }
  refreshPerpetualTrancheTVL(perp)

  let dailyStat = fetchPerpetualTrancheDailyStat(perp, dayTimestamp(event.block.timestamp))
  refreshPerpetualTrancheDailyStat(dailyStat)
}

export function handleUpdatedDepositBond(event: UpdatedDepositBond): void {
  log.debug('triggered handleUpdatedDepositBond', [])
  let perp = fetchPerpetualTranche(event.address)
  let bond = fetchBond(event.params.bond)
  perp.depositBond = bond.id
  perp.save()
}

export function handleTransfer(event: Transfer): void {
  let from = event.params.from
  let to = event.params.to
  if (from == ADDRESS_ZERO) {
    log.debug('triggered mint', [])
    let perpToken = fetchToken(event.address)
    refreshSupply(perpToken)
    let perp = fetchPerpetualTranche(event.address)
    refreshPerpetualTrancheTVL(perp)
  }

  if (to == ADDRESS_ZERO) {
    log.debug('triggered burn', [])
    let perpToken = fetchToken(event.address)
    refreshSupply(perpToken)
    let perp = fetchPerpetualTranche(event.address)
    refreshPerpetualTrancheTVL(perp)
  }

  // Mint and burn fees are handled by sending perp tokens to the perp contract
  if (to == event.address) {
    log.debug('perp fees paid', [])
    let perpToken = fetchToken(event.address)
    let perp = fetchPerpetualTranche(event.address)
    let perpFeeAmt = formatBalance(event.params.value, perpToken.decimals)
    let dailyStat = fetchPerpetualTrancheDailyStat(perp, dayTimestamp(event.block.timestamp))
    dailyStat.totalUnderlyingFeeValue = dailyStat.totalUnderlyingFeeValue.plus(
      perpFeeAmt.times(perp.price),
    )
    dailyStat.save()
  }
}
