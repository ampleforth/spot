import { Address } from '@graphprotocol/graph-ts'
import { BondIssuer } from '../../generated/schema'
import { BondIssuer as BondIssuerABI } from '../../generated/BondIssuer/BondIssuer'
import { stringToAddress } from '../utils'
import { fetchToken } from './token'

export function fetchBondIssuer(address: Address): BondIssuer {
  let id = address.toHexString()
  let issuer = BondIssuer.load(id)
  if (issuer == null) {
    let address = stringToAddress(id)
    let issuerContract = BondIssuerABI.bind(address)
    issuer = new BondIssuer(id)
    issuer.save()
  }
  return issuer as BondIssuer
}
