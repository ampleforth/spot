import {
  log,
  ethereum,
  BigInt,
  BigDecimal,
  Address,
  DataSourceContext,
} from '@graphprotocol/graph-ts'
import { RebasingERC20 } from '../generated/templates'
import { Deposit, Withdraw, Snapshot } from '../generated/CharmVault/CharmVault'
import { CharmVault as CharmVaultABI } from '../generated/CharmVault/CharmVault'
import { UniV3Pool as UniV3PoolABI } from '../generated/CharmVault/UniV3Pool'
import { ERC20 as ERC20ABI } from '../generated/CharmVault/ERC20'
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
  getPerpUnderlyingAddress,
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

    let usdAddress = vaultContract.token0()
    let usdContract = ERC20ABI.bind(usdAddress)
    vault.usd = usdAddress.toHexString()
    vault.usdName = usdContract.name()
    vault.usdSymbol = usdContract.symbol()
    vault.usdDecimals = BigInt.fromI32(usdContract.decimals())

    let perpAddress = vaultContract.token1()
    let perpContract = ERC20ABI.bind(perpAddress)
    vault.perp = perpAddress.toHexString()
    vault.perpName = perpContract.name()
    vault.perpSymbol = perpContract.symbol()
    vault.perpDecimals = BigInt.fromI32(perpContract.decimals())

    vault.usdBal = BIGDECIMAL_ZERO
    vault.perpBal = BIGDECIMAL_ZERO
    vault.usdPrice = BIGDECIMAL_ZERO
    vault.perpPrice = BIGDECIMAL_ZERO
    vault.tvl = BIGDECIMAL_ZERO
    vault.price = BIGDECIMAL_ZERO
    vault.totalSupply = BIGDECIMAL_ZERO
    vault.unusedToken0Bal = BIGDECIMAL_ZERO
    vault.unusedToken1Bal = BIGDECIMAL_ZERO
    vault.unusedTVL = BIGDECIMAL_ZERO

    let context = new DataSourceContext()
    context.setString('charmVault', id)
    RebasingERC20.createWithContext(getPerpUnderlyingAddress(perpAddress), context)
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
    dailyStat.usdBal = BIGDECIMAL_ZERO
    dailyStat.perpBal = BIGDECIMAL_ZERO
    dailyStat.usdPrice = BIGDECIMAL_ZERO
    dailyStat.perpPrice = BIGDECIMAL_ZERO
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
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
  let prices = sqrtPriceX96ToTokenPrices(sqrtPrice, vault.usdDecimals, vault.perpDecimals)

  vault.usdBal = formatBalance(tokenBals.value0, vault.usdDecimals)
  vault.perpBal = formatBalance(tokenBals.value1, vault.perpDecimals)
  vault.usdPrice = BIGDECIMAL_ONE
  vault.perpPrice = prices[0]
  vault.tvl = vault.usdBal.times(vault.usdPrice).plus(vault.perpBal.times(vault.perpPrice))
  vault.totalSupply = formatBalance(vaultContract.totalSupply(), vault.decimals)
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.unusedToken0Bal = formatBalance(vaultContract.getBalance0(), vault.usdDecimals)
  vault.unusedToken1Bal = formatBalance(vaultContract.getBalance1(), vault.perpDecimals)
  vault.unusedTVL = vault.unusedToken0Bal.plus(vault.unusedToken1Bal.times(vault.usdPrice))
  vault.save()

  dailyStat.usdBal = vault.usdBal
  dailyStat.perpBal = vault.perpBal
  dailyStat.usdPrice = vault.usdPrice
  dailyStat.perpPrice = vault.perpPrice
  dailyStat.tvl = vault.tvl
  dailyStat.totalSupply = vault.totalSupply
  dailyStat.price = vault.price
  dailyStat.save()
}

export function handleDeposit(event: Deposit): void {
  log.warn('triggered deposit', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function handleWithdraw(event: Withdraw): void {
  log.warn('triggered withdraw', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function handleSnapshot(event: Snapshot): void {
  log.warn('triggered snapshot', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}
