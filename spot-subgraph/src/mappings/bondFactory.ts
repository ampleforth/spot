import { log } from '@graphprotocol/graph-ts'
import { BigInt } from '@graphprotocol/graph-ts'
import { BondCreated } from '../../generated/BondFactory/BondFactory'
import { fetchBondFactory, fetchBond } from '../data/buttonTranche'

export function handleBondCreated(event: BondCreated): void {
  log.debug('triggered handleBondCreated', [])
  let factory = fetchBondFactory(event.address)
  factory.bondCount = factory.bondCount.plus(BigInt.fromI32(1))
  factory.save()

  let bondAddress = event.params.newBondAddress
  let bond = fetchBond(bondAddress)
  bond.factory = factory.id
  bond.save()
}
