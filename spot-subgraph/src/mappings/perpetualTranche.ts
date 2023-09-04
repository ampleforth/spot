import { log, ethereum } from '@graphprotocol/graph-ts'
import {
  ReserveSynced,
  UpdatedDepositBond,
  UpdatedMatureTrancheBalance,
} from '../../generated/PerpetualTranche/PerpetualTranche'
import {
  fetchPerpetualTranche,
  refreshPerpetualTrancheStore,
  fetchPerpetualTrancheReserveAsset,
} from '../data/perpetualTranche'
import { fetchBond } from '../data/buttonTranche'
import { fetchToken } from '../data/token'
import { formatBalance } from '../utils'

export function handleGenericStorageUpdateViaEvent(
  event: ethereum.Event,
): void {
  log.debug('triggered handleGenericStorageUpdate', [])
  refreshPerpetualTrancheStore(fetchPerpetualTranche(event.address))
}

export function handleGenericStorageUpdateViaCall(call: ethereum.Call): void {
  log.debug('triggered handleGenericStorageUpdate', [])
  refreshPerpetualTrancheStore(fetchPerpetualTranche(call.to))
}

export function handleReserveSynced(event: ReserveSynced): void {
  log.debug('triggered handleReserveSynced', [])

  let perp = fetchPerpetualTranche(event.address)
  let reserveToken = fetchToken(event.params.token)
  let reserveAsset = fetchPerpetualTrancheReserveAsset(
    event.address,
    event.params.token,
  )
  reserveAsset.balance = formatBalance(
    event.params.balance,
    reserveToken.decimals,
  )
  reserveAsset.save()
}

export function handleUpdatedDepositBond(event: UpdatedDepositBond): void {
  log.debug('triggered handleUpdatedDepositBond', [])

  let perp = fetchPerpetualTranche(event.address)
  let bond = fetchBond(event.params.bond)
  perp.depositBond = bond.id
  perp.save()
}

export function handleUpdatedMatureTrancheBalance(
  event: UpdatedMatureTrancheBalance,
): void {
  log.debug('triggered handleUpdatedMatureTrancheBalance', [])

  let perp = fetchPerpetualTranche(event.address)
  let perpToken = fetchToken(event.address)
  perp.matureTrancheBalance = formatBalance(
    event.params.matureTrancheBalance,
    perpToken.decimals,
  )
  perp.save()
}
