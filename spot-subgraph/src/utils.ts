import { BigDecimal, BigInt, Address } from '@graphprotocol/graph-ts'

export let BIGINT_ZERO = BigInt.fromI32(0)
export let BIGINT_ONE = BigInt.fromI32(1)
export let BIGDECIMAL_ZERO = new BigDecimal(BIGINT_ZERO)
export let BIGDECIMAL_ONE = new BigDecimal(BIGINT_ONE)
export let ADDRESS_ZERO = Address.fromString(
  '0x0000000000000000000000000000000000000000',
)

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
