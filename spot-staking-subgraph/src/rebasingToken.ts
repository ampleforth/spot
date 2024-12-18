import { log, dataSource, Address, BigInt } from '@graphprotocol/graph-ts'
import { LogRebase, Rebase } from '../generated/templates/RebasingERC20/RebasingERC20'
import { stringToAddress, dayTimestamp } from './utils'
import { fetchBillBroker, fetchBillBrokerDailyStat, refreshBillBrokerStats } from './billBroker'
import { fetchCharmVault, fetchCharmVaultDailyStat, refreshCharmVaultStats } from './charmVault'

function _handleRebase(address: Address, timestamp: BigInt): void {
  let context = dataSource.context()
  if (context.get('billBroker') != null) {
    let id = context.getString('billBroker')
    log.warning('billBrokerRefresh: {}', [id])
    let vault = fetchBillBroker(stringToAddress(id))
    let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(timestamp))
    refreshBillBrokerStats(vault, dailyStat)
  }

  if (context.get('charmVault') != null) {
    let id = context.getString('charmVault')
    log.warning('charmVaultRefresh: {}', [id])
    let vault = fetchCharmVault(stringToAddress(id))
    let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(timestamp))
    refreshCharmVaultStats(vault, dailyStat)
  }
}

export function handleRebase(event: Rebase): void {
  log.warning('triggered handleRebase', [])
  _handleRebase(event.address, event.block.timestamp)
}

export function handleLogRebase(event: LogRebase): void {
  log.warning('triggered handleLogRebase', [])
  _handleRebase(event.address, event.block.timestamp)
}
