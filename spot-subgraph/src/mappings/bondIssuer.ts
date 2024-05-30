import { log } from '@graphprotocol/graph-ts'
import { BondIssued } from '../../generated/BondIssuer/BondIssuer'
import { fetchBondIssuer } from '../data/bondIssuer'
import { fetchBond } from '../data/buttonTranche'

export function handleBondIssued(event: BondIssued): void {
  log.debug('triggered handleBondIssued', [])

  let issuer = fetchBondIssuer(event.address)
  issuer.lastIssueTimestamp = event.block.timestamp
  issuer.save()

  let bond = fetchBond(event.params.bond)
  bond.issuer = issuer.id
  bond.save()
}
