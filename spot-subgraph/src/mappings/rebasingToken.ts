import { log, dataSource, Address, BigInt } from '@graphprotocol/graph-ts'
import { LogRebase, Rebase } from '../../generated/templates/RebasingToken/RebasingERC20'
import { fetchToken, refreshSupply } from '../data/token'
import { fetchBond, refreshBond } from '../data/buttonTranche'
import {
  fetchPerpetualTranche,
  refreshPerpetualTrancheTVL,
  refreshPerpetualTrancheDailyStat,
  fetchPerpetualTrancheDailyStat,
} from '../data/perpetualTranche'
import {
  fetchRolloverVault,
  refreshRolloverVaultTVL,
  refreshRolloverVaultRebaseMultiplier,
  refreshRolloverVaultDailyStat,
  fetchRolloverVaultDailyStat,
} from '../data/rolloverVault'
import { stringToAddress, dayTimestamp } from '../utils'

function _handleRebase(address: Address, timestamp: BigInt): void {
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
    refreshPerpetualTrancheTVL(perp)

    let dailyStat = fetchPerpetualTrancheDailyStat(perp, dayTimestamp(timestamp))
    refreshPerpetualTrancheDailyStat(dailyStat)
  }

  if (context.get('vault') != null) {
    let vaultId = context.getString('vault')
    log.debug('vaultRefresh: {}', [vaultId])
    let vault = fetchRolloverVault(stringToAddress(vaultId))
    refreshRolloverVaultTVL(vault)
    refreshRolloverVaultRebaseMultiplier(vault)

    let dailyStat = fetchRolloverVaultDailyStat(vault, dayTimestamp(timestamp))
    refreshRolloverVaultDailyStat(dailyStat)
  }
}

export function handleRebase(event: Rebase): void {
  log.debug('triggered handleRebase', [])
  _handleRebase(event.address, event.block.timestamp)
}

export function handleLogRebase(event: LogRebase): void {
  log.debug('triggered handleLogRebase', [])
  _handleRebase(event.address, event.block.timestamp)
}
