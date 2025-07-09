import { BigDecimal, BigInt, Address } from '@graphprotocol/graph-ts'
import { ERC20 as ERC20ABI } from '../generated/BondFactory/ERC20'
import { Tranche as TrancheABI } from '../generated/BondFactory/Tranche'
import { BondController as BondControllerABI } from '../generated/BondFactory/BondController'

export let BIGINT_ZERO = BigInt.fromI32(0)
export let BIGINT_ONE = BigInt.fromI32(1)
export let BIGDECIMAL_ZERO = new BigDecimal(BIGINT_ZERO)
export let BIGDECIMAL_ONE = new BigDecimal(BIGINT_ONE)
export let ADDRESS_ZERO = Address.fromString('0x0000000000000000000000000000000000000000')

export const formatDecimalBalance = (value: BigDecimal, decimals: BigInt): BigInt => {
  return toBigInt(
    value.times(
      BigInt.fromI32(10)
        .pow(decimals.toI32() as u8)
        .toBigDecimal(),
    ),
  )
}

function toBigInt(n: BigDecimal): BigInt {
  return BigInt.fromString(n.toString().split('.')[0])
}

export const formatBalance = (wei: BigInt, decimals: BigInt): BigDecimal => {
  return wei.toBigDecimal().div(
    BigInt.fromI32(10)
      .pow(decimals.toI32() as u8)
      .toBigDecimal(),
  )
}

export const stringToAddress = (id: string): Address => {
  return Address.fromString(id)
}

export const dayTimestamp = (timestamp: BigInt): BigInt => {
  return timestamp.minus(timestamp % BigInt.fromI32(24 * 3600))
}

export function addToSet(set: string[], e: string): string[] {
  let isPresent = false
  for (let i = 0; i < set.length; i++) {
    if (set[i] == e) {
      isPresent = true
      break
    }
  }
  if (!isPresent) {
    set.push(e)
  }
  return set
}

export function removeFromSet(set: string[], e: string): string[] {
  let isPresent = false
  let set_: string[] = []
  for (let i = 0; i < set.length; i++) {
    if (set[i] != e) {
      set_.push(set[i])
    }
  }
  return set_
}

export class CDRInfo {
  isBondMature: boolean
  isSeniorTranche: boolean
  trancheSupply: BigDecimal
  bondCollateralBalance: BigDecimal
  bondTotalDebt: BigDecimal
  trancheClaim: BigDecimal
  trancheCDR: BigDecimal
  bondCDR: BigDecimal
  tranchePrice: BigDecimal
  trancheValue: BigDecimal
}

export function getTrancheCDRInfo(
  trancheAddress: Address,
  underlyingAddress: Address,
  trancheBalance: BigDecimal,
): CDRInfo {
  let underlyingERC20Contract = ERC20ABI.bind(underlyingAddress)
  let decimals = BigInt.fromI32(underlyingERC20Contract.decimals())
  let trancheContract = TrancheABI.bind(trancheAddress)
  let bondAddress = trancheContract.bond()
  let bondContract = BondControllerABI.bind(bondAddress)
  let bondSeniorTrancheData = bondContract.tranches(BIGINT_ZERO)

  let r = new CDRInfo()
  r.isBondMature = bondContract.isMature() == 1
  r.isSeniorTranche = bondSeniorTrancheData.value0 == trancheAddress
  r.trancheSupply = formatBalance(trancheContract.totalSupply(), decimals)
  r.bondCollateralBalance = formatBalance(underlyingERC20Contract.balanceOf(bondAddress), decimals)
  r.bondTotalDebt = formatBalance(bondContract.totalDebt(), decimals)

  if (r.trancheSupply.equals(BIGDECIMAL_ZERO)) {
    return r
  }

  if (!r.isBondMature) {
    if (!r.isSeniorTranche) {
      let seniorTrancheContract = ERC20ABI.bind(bondSeniorTrancheData.value0)
      let seniorSupply = formatBalance(seniorTrancheContract.totalSupply(), decimals)
      r.trancheClaim = r.bondCollateralBalance.gt(seniorSupply)
        ? r.bondCollateralBalance.minus(seniorSupply)
        : BIGDECIMAL_ZERO
      r.trancheCDR = r.trancheClaim.div(r.trancheSupply)
    } else {
      r.trancheClaim = r.bondCollateralBalance.gt(r.trancheSupply)
        ? r.trancheSupply
        : r.bondCollateralBalance
      r.trancheCDR = r.bondCollateralBalance.div(r.trancheSupply)
    }
    r.bondCDR = r.bondCollateralBalance.div(r.bondTotalDebt)
  } else {
    r.trancheClaim = formatBalance(underlyingERC20Contract.balanceOf(trancheAddress), decimals)
    r.trancheCDR = r.trancheClaim.div(r.trancheSupply)
    r.bondCDR = r.trancheCDR
  }
  r.tranchePrice = r.trancheClaim.div(r.trancheSupply)
  r.trancheValue = trancheBalance.times(r.tranchePrice)
  return r
}
