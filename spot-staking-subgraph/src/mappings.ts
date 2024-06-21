import { log, ethereum, BigInt, BigDecimal, Address } from '@graphprotocol/graph-ts'
import { Deposit, Withdraw, Snapshot } from '../generated/CharmVault/CharmVault'
import { CharmVault as CharmVaultABI } from '../generated/CharmVault/CharmVault'
import { UniV3Pool as UniV3PoolABI } from '../generated/CharmVault/UniV3Pool'
import { ERC20 as ERC20ABI } from '../generated/CharmVault/ERC20'
import { CharmVault, CharmVaultDailyStat } from '../generated/schema'

let BIGINT_ZERO = BigInt.fromI32(0)
let BIGDECIMAL_ZERO = BigDecimal.fromString('0')
let BIGDECIMAL_ONE = BigDecimal.fromString('1')

let BLOCK_UPDATE_INTERVAL = BigInt.fromI32(240)
let CHARM_VAULT_ID = '0x2dcaff0f75765d7867887fc402b71c841b3a4bfb'
let CHARM_VAULT_UPDATE_BLOCK = BigInt.fromI32(19798270)

const dayTimestamp = (timestamp: BigInt): BigInt => {
  return timestamp.minus(timestamp % BigInt.fromI32(24 * 3600))
}
const stringToAddress = (id: string): Address => {
  return Address.fromString(id)
}
const formatBalance = (wei: BigInt, decimals: BigInt): BigDecimal => {
  return wei.toBigDecimal().div(
    BigInt.fromI32(10)
      .pow(decimals.toI32() as u8)
      .toBigDecimal(),
  )
}

// https://github.com/Uniswap/v3-subgraph/blob/main/src/utils/index.ts#L30
function exponentToBigDecimal(decimals: BigInt): BigDecimal {
  let resultString = '1'
  for (let i = 0; i < decimals.toI32(); i++) {
    resultString += '0'
  }
  return BigDecimal.fromString(resultString)
}
function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
  if (amount1.equals(BIGDECIMAL_ZERO)) {
    return BIGDECIMAL_ZERO
  } else {
    return amount0.div(amount1)
  }
}
function sqrtPriceX96ToTokenPrices(
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

function fetchCharmVault(address: Address): CharmVault {
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
    vault.token0BalIn = BIGDECIMAL_ZERO
    vault.token1BalIn = BIGDECIMAL_ZERO
    vault.token0Price = BIGDECIMAL_ZERO
    vault.token1Price = BIGDECIMAL_ZERO
    vault.tvl = BIGDECIMAL_ZERO
    vault.valueIn = BIGDECIMAL_ZERO
    vault.price = BIGDECIMAL_ZERO
    vault.totalSupply = BIGDECIMAL_ZERO
    vault.unusedToken0Bal = BIGDECIMAL_ZERO
    vault.unusedToken1Bal = BIGDECIMAL_ZERO
    vault.unusedTVL = BIGDECIMAL_ZERO
    vault.save()
  }
  return vault as CharmVault
}

function fetchCharmVaultDailyStat(vault: CharmVault, timestamp: BigInt): CharmVaultDailyStat {
  let id = vault.id.concat('-').concat(timestamp.toString())
  let dailyStat = CharmVaultDailyStat.load(id)
  if (dailyStat === null) {
    dailyStat = new CharmVaultDailyStat(id)
    dailyStat.vault = vault.id
    dailyStat.timestamp = timestamp
    dailyStat.token0Bal = BIGDECIMAL_ZERO
    dailyStat.token1Bal = BIGDECIMAL_ZERO
    dailyStat.token0BalIn = BIGDECIMAL_ZERO
    dailyStat.token1BalIn = BIGDECIMAL_ZERO
    dailyStat.token0Price = BIGDECIMAL_ZERO
    dailyStat.token1Price = BIGDECIMAL_ZERO
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.valueIn = BIGDECIMAL_ZERO
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
    dailyStat.save()
  }
  return dailyStat as CharmVaultDailyStat
}

function refreshCharmVaultStats(vault: CharmVault, dailyStat: CharmVaultDailyStat): void {
  let vaultContract = CharmVaultABI.bind(stringToAddress(vault.id))
  let tokenBals = vaultContract.getTotalAmounts()
  let uniPoolContract = UniV3PoolABI.bind(stringToAddress(vault.pool))
  let slot0 = uniPoolContract.slot0()
  let sqrtPrice = slot0.value0
  let prices = sqrtPriceX96ToTokenPrices(sqrtPrice, vault.token0Decimals, vault.token1Decimals)

  vault.token0Bal = formatBalance(tokenBals.value0, vault.token0Decimals)
  vault.token1Bal = formatBalance(tokenBals.value1, vault.token1Decimals)
  vault.token0Price = prices[0]
  vault.token1Price = prices[1]
  vault.tvl = vault.token0Bal.plus(vault.token1Bal.times(vault.token0Price))
  vault.totalSupply = formatBalance(vaultContract.totalSupply(), vault.decimals)
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.unusedToken0Bal = formatBalance(vaultContract.getBalance0(), vault.token0Decimals)
  vault.unusedToken1Bal = formatBalance(vaultContract.getBalance1(), vault.token1Decimals)
  vault.unusedTVL = vault.unusedToken0Bal.plus(vault.unusedToken1Bal.times(vault.token0Price))
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
  log.debug('triggered deposit', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
  vault.token0BalIn = vault.token0BalIn.plus(
    formatBalance(event.params.amount0, vault.token0Decimals),
  )
  vault.token1BalIn = vault.token1BalIn.plus(
    formatBalance(event.params.amount1, vault.token1Decimals),
  )
  vault.valueIn = vault.token0BalIn.plus(vault.token1BalIn.times(vault.token0Price))
  vault.save()

  dailyStat.token0BalIn = vault.token0BalIn
  dailyStat.token1BalIn = vault.token1BalIn
  dailyStat.valueIn = vault.valueIn
  dailyStat.save()
}

export function handleWithdraw(event: Withdraw): void {
  log.debug('triggered withdraw', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
  vault.token0BalIn = vault.token0BalIn.minus(
    formatBalance(event.params.amount0, vault.token0Decimals),
  )
  vault.token1BalIn = vault.token1BalIn.minus(
    formatBalance(event.params.amount1, vault.token1Decimals),
  )
  vault.valueIn = vault.token0BalIn.plus(vault.token1BalIn.times(vault.token0Price))
  vault.save()

  dailyStat.token0BalIn = vault.token0BalIn
  dailyStat.token1BalIn = vault.token1BalIn
  dailyStat.valueIn = vault.valueIn
  dailyStat.save()
  dailyStat.save()
}

export function handleSnapshot(event: Snapshot): void {
  log.debug('triggered snapshot', [])
  let vault = fetchCharmVault(event.address)
  let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(event.block.timestamp))
  refreshCharmVaultStats(vault, dailyStat)
}

export function refreshStore(block: ethereum.Block): void {
  let timeForUpdate =
    block.number.gt(CHARM_VAULT_UPDATE_BLOCK) &&
    block.number.mod(BLOCK_UPDATE_INTERVAL).equals(BIGINT_ZERO)
  if (timeForUpdate) {
    log.debug('triggered store refresh', [])
    let vault = fetchCharmVault(stringToAddress(CHARM_VAULT_ID))
    let dailyStat = fetchCharmVaultDailyStat(vault, dayTimestamp(block.timestamp))
    refreshCharmVaultStats(vault, dailyStat)
  }
}
