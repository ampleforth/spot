import { log, dataSource, Address } from '@graphprotocol/graph-ts'
import {
  LogRebase,
  Rebase,
} from '../../generated/templates/RebasingToken/RebasingERC20'
import { fetchToken, refreshSupply } from '../data/token'
import { fetchBond, refreshBond } from '../data/buttonTranche'
import {
  fetchPerpetualTranche,
  refreshPerpetualTrancheStore,
} from '../data/perpetualTranche'
import { stringToAddress } from '../utils'

function _handleRebase(address: Address): void {
  let token = fetchToken(address)
  refreshSupply(token)

  let context = dataSource.context()
  if (context.get('bond') != null) {
    let bondId = context.getString('bond')
    log.debug('bondRefresh: {}', [bondId])
    let bond = fetchBond(stringToAddress(bondId))
    refreshBond(bond)
  }

  if (context.get('perp') != null) {
    let perpId = context.getString('perp')
    log.debug('perpRefresh: {}', [perpId])
    let perp = fetchPerpetualTranche(stringToAddress(perpId))
    refreshPerpetualTrancheStore(perp)
  }
}

export function handleRebase(event: Rebase): void {
  log.debug('triggered handleRebase', [])
  _handleRebase(event.address)
}

export function handleLogRebase(event: LogRebase): void {
  log.debug('triggered handleLogRebase', [])
  _handleRebase(event.address)
}
