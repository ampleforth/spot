import { log } from '@graphprotocol/graph-ts'
import { BigInt } from '@graphprotocol/graph-ts'
import {
  Deposit,
  FeeUpdate,
  Mature,
  OwnershipTransferred,
  Redeem,
  RedeemMature,
} from '../../generated/templates/BondController/BondController'
import { fetchTranche, fetchBond, refreshBond, matureBond } from '../data/buttonTranche'
import { fetchToken } from '../data/token'

import { BIGDECIMAL_ZERO, stringToAddress, formatBalance } from '../utils'

export function handleDeposit(event: Deposit): void {
  log.debug('triggered handleDeposit', [])
  refreshBond(fetchBond(event.address))
}

export function handleRedeem(event: Redeem): void {
  log.debug('triggered handleRedeem', [])
  refreshBond(fetchBond(event.address))
}

export function handleRedeemMature(event: RedeemMature): void {
  log.debug('triggered handleRedeemMature', [])
  refreshBond(fetchBond(event.address))
}

export function handleMature(event: Mature): void {
  log.debug('triggered handleMature', [])
  let bond = fetchBond(event.address)
  refreshBond(bond)
  matureBond(bond, event.block)
}
