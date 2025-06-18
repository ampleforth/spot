import { BigInt, BigDecimal, Address } from '@graphprotocol/graph-ts'

import { Wrapper as WrapperABI } from '../generated/CharmSPOTVault/Wrapper'

export let BIGINT_ZERO = BigInt.fromI32(0)
export let BIGINT_ONE = BigInt.fromI32(1)
export let BIGDECIMAL_ZERO = BigDecimal.fromString('0')
export let BIGDECIMAL_ONE = BigDecimal.fromString('1')

export const dayTimestamp = (timestamp: BigInt): BigInt => {
  return timestamp.minus(timestamp % BigInt.fromI32(24 * 3600))
}

export const stringToAddress = (id: string): Address => {
  return Address.fromString(id)
}

export const formatBalance = (wei: BigInt, decimals: BigInt): BigDecimal => {
  return wei.toBigDecimal().div(
    BigInt.fromI32(10)
      .pow(decimals.toI32() as u8)
      .toBigDecimal(),
  )
}

// https://github.com/Uniswap/v3-subgraph/blob/main/src/utils/index.ts#L30
export function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let resultString = '1'
  for (let i = 0; i < decimals.toI32(); i++) {
    resultString += '0'
  }
  return BigDecimal.fromString(resultString)
}

export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.equals(BIGDECIMAL_ZERO)) {
    return BIGDECIMAL_ZERO
  } else {
    return amount0.div(amount1)
  }
}

export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: BigInt,
  token0Decimals: BigInt,
  token1Decimals: BigInt,
): BigDecimal[] {
  let Q192 = BigInt.fromI32(2).pow(192 as u8)
  let num = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal()
  let denom = BigDecimal.fromString(Q192.toString())
  let price1 = num
    .div(denom)
    .times(exponentToBigDecimal(token0Decimals))
    .div(exponentToBigDecimal(token1Decimals))
  let price0 = safeDiv(BigDecimal.fromString('1'), price1)
  return [price0, price1]
}

export function getUnderlyingAddress(tokenAddress: Address): Address {
  let wrapperContract = WrapperABI.bind(tokenAddress)
  let underlyingResult = wrapperContract.try_underlying()
  if (!underlyingResult.reverted) {
    return underlyingResult.value
  }
  let collateralResult = wrapperContract.try_collateral()
  if (!collateralResult.reverted) {
    return collateralResult.value
  }
  return Address.fromString('0x0000000000000000000000000000000000000000')
}
