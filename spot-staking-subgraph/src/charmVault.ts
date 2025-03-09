import {
  log,
  ethereum,
  BigInt,
  BigDecimal,
  Address,
  DataSourceContext,
} from '@graphprotocol/graph-ts'
import { RebasingERC20 } from '../generated/templates'
import { Deposit, Withdraw, Snapshot, CollectFees } from '../generated/CharmSPOTVault/CharmVault'
import { CharmVault as CharmVaultABI } from '../generated/CharmSPOTVault/CharmVault'
import { UniV3Pool as UniV3PoolABI } from '../generated/CharmSPOTVault/UniV3Pool'
import { ERC20 as ERC20ABI } from '../generated/CharmSPOTVault/ERC20'
import { CharmVault, CharmVaultDailyStat } from '../generated/schema'

import {
  BIGINT_ZERO,
  BIGINT_ONE,
  BIGDECIMAL_ZERO,
  BIGDECIMAL_ONE,
  dayTimestamp,
  stringToAddress,
  formatBalance,
  exponentToBigDecimal,
  safeDiv,
  sqrtPriceX96ToTokenPrices,
  getUnderlyingAddress,
} from './utils'

export function fetchCharmVault(address: Address): CharmVault {
  let id = address.toHexString()
  let vault = CharmVault.load(id)
  if (vault === null) {
    vault = new CharmVault(id)
    let vaultContract = CharmVaultABI.bind(address)
    vault.pool = vaultContract.pool().toHexString()
    vault.name = vaultContract.name()
    vault.symbol = vaultContract.symbol()
    vault.decimals = BigInt.fromI32(vaultContract.decimals())

    let token0Address = vaultContract.token0()
    let token0Contract = ERC20ABI.bind(token0Address)
    vault.token0 = token0Address.toHexString()
    vault.token0Name = token0Contract.name()
    vault.token0Symbol = token0Contract.symbol()
    vault.token0Decimals = BigInt.fromI32(token0Contract.decimals())

    let token1Address = vaultContract.token1()
    let token1Contract = ERC20ABI.bind(token1Address)
    vault.token1 = token1Address.toHexString()
    vault.token1Name = token1Contract.name()
    vault.token1Symbol = token1Contract.symbol()
    vault.token1Decimals = BigInt.fromI32(token1Contract.decimals())

    vault.token0Bal = BIGDECIMAL_ZERO
    vault.token1Bal = BIGDECIMAL_ZERO
    vault.token0Price = BIGDECIMAL_ZERO
    vault.token1Price = BIGDECIMAL_ZERO
    vault.tvl = BIGDECIMAL_ZERO
    vault.price = BIGDECIMAL_ZERO
    vault.totalSupply = BIGDECIMAL_ZERO
    
    let context = new DataSourceContext()
    context.setString('charmVault', id)
    RebasingERC20.createWithContext(getUnderlyingAddress(token1Address), context)
    vault.save()
  }
  return vault as CharmVault
}

export function fetchCharmVaultDailyStat(vault: CharmVault, timestamp: BigInt): CharmVaultDailyStat {
  let id = vault.id.concat('-').concat(timestamp.toString())
  let dailyStat = CharmVaultDailyStat.load(id)
  if (dailyStat === null) {
    dailyStat = new CharmVaultDailyStat(id)
    dailyStat.vault = vault.id
    dailyStat.timestamp = timestamp
    dailyStat.token0Bal = BIGDECIMAL_ZERO
    dailyStat.token1Bal = BIGDECIMAL_ZERO
    dailyStat.token0Price = BIGDECIMAL_ZERO
    dailyStat.token1Price = BIGDECIMAL_ZERO
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
    dailyStat.token0Fees = BIGDECIMAL_ZERO
    dailyStat.token1Fees = BIGDECIMAL_ZERO
    dailyStat.totalFeeVal = BIGDECIMAL_ZERO
    dailyStat.feeYield = BIGDECIMAL_ZERO
    dailyStat.save()
  }
  return dailyStat as CharmVaultDailyStat
}

export function refreshCharmVaultStats(vault: CharmVault, dailyStat: CharmVaultDailyStat): void {
  let vaultContract = CharmVaultABI.bind(stringToAddress(vault.id))
  let tokenBals = vaultContract.getTotalAmounts()
  let uniPoolContract = UniV3PoolABI.bind(stringToAddress(vault.pool))
  let slot0 = uniPoolContract.slot0()
  let sqrtPrice = slot0.value0
  let prices = sqrtPriceX96ToTokenPrices(sqrtPrice, vault.token0Decimals, vault.token1Decimals)

  vault.token0Bal = formatBalance(tokenBals.value0, vault.token0Decimals)
  vault.token1Bal = formatBalance(tokenBals.value1, vault.token1Decimals)
  vault.token0Price = BIGDECIMAL_ONE
  vault.token1Price = prices[0]
  vault.tvl = vault.token0Bal.times(vault.token0Price).plus(vault.token1Bal.times(vault.token1Price))
  vault.totalSupply = formatBalance(vaultContract.totalSupply(), vault.decimals)
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.save()

  dailyStat.token0Bal = vault.token0Bal
  dailyStat.token1Bal = vault.token1Bal
  dailyStat.token0Price = vault.token0Price
  dailyStat.token1Price = vault.token1Price
  dailyStat.tvl = vault.tvl
  dailyStat.totalSupply = vault.totalSupply
  dailyStat.price = vault.price
  dailyStat.save()
}

export function handleDeposit(event: Deposit): void {
  log.warning('triggered deposit', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function handleWithdraw(event: Withdraw): void {
  log.warning('triggered withdraw', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function handleSnapshot(event: Snapshot): void {
  log.warning('triggered snapshot', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function handleFees(event: CollectFees): void {
  log.warning('triggered collect fees', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)

  dailyStat.token0Fees = dailyStat.token0Fees.plus(formatBalance(event.params.feesToVault0, vault.token0Decimals))
  dailyStat.token1Fees = dailyStat.token1Fees.plus(formatBalance(event.params.feesToVault1, vault.token1Decimals))
  dailyStat.totalFeeVal = dailyStat.token1Fees.times(dailyStat.token1Price).plus(dailyStat.token0Fees.times(dailyStat.token0Price))
  dailyStat.feeYield = dailyStat.totalFeeVal.div(dailyStat.tvl.minus(dailyStat.totalFeeVal))
  dailyStat.save()
}
