import {
  log,
  ethereum,
  BigInt,
  BigDecimal,
  Address,
  DataSourceContext,
} from '@graphprotocol/graph-ts'
import { RebasingERC20 } from '../generated/templates'
import {
  DepositCall,
  RedeemCall,
  DepositUSD,
  DepositPerp,
  SwapPerpsForUSD,
  SwapUSDForPerps,
} from '../generated/BillBroker/BillBroker'
import {
  BillBroker__computePerpToUSDSwapAmt1InputSStruct,
  BillBroker__computeUSDToPerpSwapAmtInputSStruct,
  BillBroker__computeMintAmtWithUSD1InputSStruct,
  BillBroker__computeMintAmtWithPerp1InputSStruct,
} from '../generated/BillBroker/BillBroker'
import { BillBroker as BillBrokerABI } from '../generated/BillBroker/BillBroker'
import { ERC20 as ERC20ABI } from '../generated/BillBroker/ERC20'
import { BillBroker, BillBrokerDailyStat, BillBrokerSwap } from '../generated/schema'
import {
  BIGINT_ZERO,
  BIGINT_ONE,
  BIGDECIMAL_ZERO,
  BIGDECIMAL_ONE,
  dayTimestamp,
  stringToAddress,
  formatBalance,
  getUnderlyingAddress,
} from './utils'

export function fetchBillBroker(address: Address): BillBroker {
  let id = address.toHexString()
  let vault = BillBroker.load(id)
  if (vault === null) {
    vault = new BillBroker(id)
    let vaultContract = BillBrokerABI.bind(address)
    vault.name = vaultContract.name()
    vault.symbol = vaultContract.symbol()
    vault.decimals = BigInt.fromI32(vaultContract.decimals())

    let perpAddress = vaultContract.perp()
    let perpContract = ERC20ABI.bind(perpAddress)
    vault.perp = perpAddress.toHexString()
    vault.perpName = perpContract.name()
    vault.perpSymbol = perpContract.symbol()
    vault.perpDecimals = BigInt.fromI32(perpContract.decimals())

    let usdAddress = vaultContract.usd()
    let usdContract = ERC20ABI.bind(usdAddress)
    vault.usd = usdAddress.toHexString()
    vault.usdName = usdContract.name()
    vault.usdSymbol = usdContract.symbol()
    vault.usdDecimals = BigInt.fromI32(usdContract.decimals())

    vault.perpBal = BIGDECIMAL_ZERO
    vault.usdBal = BIGDECIMAL_ZERO
    vault.perpPrice = BIGDECIMAL_ZERO
    vault.usdPrice = BIGDECIMAL_ZERO
    vault.totalSupply = BIGDECIMAL_ZERO
    vault.tvl = BIGDECIMAL_ZERO
    vault.price = BIGDECIMAL_ZERO
    vault.swapNonce = BIGINT_ZERO

    let context = new DataSourceContext()
    context.setString('billBroker', id)
    RebasingERC20.createWithContext(getUnderlyingAddress(perpAddress), context)
    vault.save()
  }
  return vault as BillBroker
}

export function fetchBillBrokerDailyStat(
  vault: BillBroker,
  timestamp: BigInt,
): BillBrokerDailyStat {
  let id = vault.id.concat('-').concat(timestamp.toString())
  let dailyStat = BillBrokerDailyStat.load(id)
  if (dailyStat === null) {
    dailyStat = new BillBrokerDailyStat(id)
    dailyStat.vault = vault.id
    dailyStat.timestamp = timestamp
    dailyStat.perpBal = BIGDECIMAL_ZERO
    dailyStat.usdBal = BIGDECIMAL_ZERO
    dailyStat.perpPrice = BIGDECIMAL_ZERO
    dailyStat.usdPrice = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
    dailyStat.swapValue = BIGDECIMAL_ZERO
    dailyStat.feeValue = BIGDECIMAL_ZERO
    dailyStat.feeYield = BIGDECIMAL_ZERO
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.save()
  }
  return dailyStat as BillBrokerDailyStat
}

function fetchBillBrokerSwap(vault: BillBroker, nonce: BigInt): BillBrokerSwap {
  let id = vault.id.concat('-').concat(nonce.toString())
  let swap = BillBrokerSwap.load(id)
  if (swap === null) {
    swap = new BillBrokerSwap(id)
    swap.vault = vault.id
    swap.nonce = nonce
    swap.type = ''
    swap.swapAmt = BIGDECIMAL_ZERO
    swap.swapValue = BIGDECIMAL_ZERO
    swap.feeValue = BIGDECIMAL_ZERO
    swap.tx = '0x'
    swap.timestamp = BIGINT_ZERO
    swap.save()
  }
  return swap as BillBrokerSwap
}

export function refreshBillBrokerStats(vault: BillBroker, dailyStat: BillBrokerDailyStat): void {
  let vaultContract = BillBrokerABI.bind(stringToAddress(vault.id))
  vault.perpBal = formatBalance(vaultContract.perpBalance(), vault.perpDecimals)
  vault.usdBal = formatBalance(vaultContract.usdBalance(), vault.usdDecimals)
  vault.totalSupply = formatBalance(vaultContract.totalSupply(), vault.decimals)
  vault.save()

  dailyStat.perpBal = vault.perpBal
  dailyStat.usdBal = vault.usdBal
  dailyStat.totalSupply = vault.totalSupply
  dailyStat.save()
}

export function handleDeposit(call: DepositCall): void {
  log.warning('triggered deposit', [])
  let vault = fetchBillBroker(call.to)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(call.block.timestamp))
  refreshBillBrokerStats(vault, dailyStat)
}

export function handleRedeem(call: RedeemCall): void {
  log.warning('triggered redeem', [])
  let vault = fetchBillBroker(call.to)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(call.block.timestamp))
  refreshBillBrokerStats(vault, dailyStat)
}

export function handleSwapPerpsForUSD(event: SwapPerpsForUSD): void {
  log.warning('triggered swap perps', [])
  let vault = fetchBillBroker(event.address)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(event.block.timestamp))
  let swap = fetchBillBrokerSwap(vault, vault.swapNonce.plus(BIGINT_ONE))
  refreshBillBrokerStats(vault, dailyStat)

  vault.perpPrice = formatBalance(event.params.preOpState.perpPrice, vault.decimals)
  vault.usdPrice = formatBalance(event.params.preOpState.usdPrice, vault.decimals)
  vault.tvl = vault.usdBal.times(vault.usdPrice).plus(vault.perpBal.times(vault.perpPrice))
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.swapNonce = vault.swapNonce.plus(BIGINT_ONE)
  vault.save()

  dailyStat.perpPrice = vault.perpPrice
  dailyStat.usdPrice = vault.usdPrice
  dailyStat.tvl = vault.tvl
  dailyStat.price = vault.price
  dailyStat.save()

  swap.type = 'perps'
  swap.swapAmt = formatBalance(event.params.perpAmtIn, vault.perpDecimals)
  swap.swapValue = swap.swapAmt.times(vault.perpPrice)
  swap.tx = event.transaction.hash.toHex()
  swap.timestamp = event.block.timestamp
  swap.save()

  let vaultContract = BillBrokerABI.bind(stringToAddress(vault.id))
  let reserveStateValues: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdPrice),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpPrice),
  ]
  let reserveStateTuple = changetype<ethereum.Tuple>(reserveStateValues)
  let reserveStateStruct = changetype<BillBroker__computePerpToUSDSwapAmt1InputSStruct>(
    reserveStateTuple,
  )
  let r = vaultContract.try_computePerpToUSDSwapAmt1(event.params.perpAmtIn, reserveStateStruct)
  if (!r.reverted) {
    let swapAmts = r.value
    let perpAmtIn = swap.swapAmt
    let usdAmtOut = formatBalance(swapAmts.value0, vault.usdDecimals)
    let estUsdAmtOut = perpAmtIn.times(vault.perpPrice).div(vault.usdPrice)
    let usdFeeAmt = estUsdAmtOut.minus(usdAmtOut)
    let feeValue = usdFeeAmt.times(vault.usdPrice)
    dailyStat.swapValue = dailyStat.swapValue.plus(swap.swapValue)
    dailyStat.feeValue = dailyStat.feeValue.plus(feeValue)
    dailyStat.feeYield = dailyStat.feeValue.div(dailyStat.tvl)
    dailyStat.save()
    swap.feeValue = feeValue
    swap.save()
  }
}

export function handleSwapUSDForPerps(event: SwapUSDForPerps): void {
  log.warning('triggered swap usd', [])
  let vault = fetchBillBroker(event.address)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(event.block.timestamp))
  let swap = fetchBillBrokerSwap(vault, vault.swapNonce.plus(BIGINT_ONE))
  refreshBillBrokerStats(vault, dailyStat)

  vault.perpPrice = formatBalance(event.params.preOpState.perpPrice, vault.decimals)
  vault.usdPrice = formatBalance(event.params.preOpState.usdPrice, vault.decimals)
  vault.tvl = vault.usdBal.times(vault.usdPrice).plus(vault.perpBal.times(vault.perpPrice))
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.swapNonce = vault.swapNonce.plus(BIGINT_ONE)
  vault.save()

  dailyStat.perpPrice = vault.perpPrice
  dailyStat.usdPrice = vault.usdPrice
  dailyStat.tvl = vault.tvl
  dailyStat.price = vault.price
  dailyStat.save()

  swap.type = 'usd'
  swap.swapAmt = formatBalance(event.params.usdAmtIn, vault.usdDecimals)
  swap.swapValue = swap.swapAmt.times(vault.usdPrice)
  swap.tx = event.transaction.hash.toHex()
  swap.timestamp = event.block.timestamp
  swap.save()

  let vaultContract = BillBrokerABI.bind(stringToAddress(vault.id))
  let reserveStateValues: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdPrice),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpPrice),
  ]
  let reserveStateTuple = changetype<ethereum.Tuple>(reserveStateValues)
  let reserveStateStruct = changetype<BillBroker__computeUSDToPerpSwapAmtInputSStruct>(
    reserveStateTuple,
  )
  let r = vaultContract.try_computeUSDToPerpSwapAmt(event.params.usdAmtIn, reserveStateStruct)
  if (!r.reverted) {
    let swapAmts = r.value
    let usdAmtIn = swap.swapAmt
    let perpAmtOut = formatBalance(swapAmts.value0, vault.perpDecimals)
    let estPerpAmtOut = usdAmtIn.times(vault.usdPrice).div(vault.perpPrice)
    let perpFeeAmt = estPerpAmtOut.minus(perpAmtOut)
    let feeValue = perpFeeAmt.times(vault.perpPrice)
    dailyStat.swapValue = dailyStat.swapValue.plus(swap.swapValue)
    dailyStat.feeValue = dailyStat.feeValue.plus(feeValue)
    dailyStat.feeYield = dailyStat.feeValue.div(dailyStat.tvl)
    dailyStat.save()
    swap.feeValue = feeValue
    swap.save()
  }
}

export function handleDepositUSD(event: DepositUSD): void {
  log.warning('triggered single sided deposit', [])
  let vault = fetchBillBroker(event.address)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(event.block.timestamp))
  let swap = fetchBillBrokerSwap(vault, vault.swapNonce.plus(BIGINT_ONE))
  refreshBillBrokerStats(vault, dailyStat)

  vault.perpPrice = formatBalance(event.params.preOpState.perpPrice, vault.decimals)
  vault.usdPrice = formatBalance(event.params.preOpState.usdPrice, vault.decimals)
  vault.tvl = vault.usdBal.times(vault.usdPrice).plus(vault.perpBal.times(vault.perpPrice))
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.save()

  dailyStat.perpPrice = vault.perpPrice
  dailyStat.usdPrice = vault.usdPrice
  dailyStat.tvl = vault.tvl
  dailyStat.price = vault.price
  dailyStat.save()

  let vaultContract = BillBrokerABI.bind(stringToAddress(vault.id))
  let reserveStateValues: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdPrice),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpPrice),
  ]
  let reserveStateTuple = changetype<ethereum.Tuple>(reserveStateValues)
  let reserveStateStruct = changetype<BillBroker__computeMintAmtWithUSD1InputSStruct>(
    reserveStateTuple,
  )
  let r = vaultContract.try_computeMintAmtWithUSD1(event.params.usdAmtIn, reserveStateStruct)
  if (!r.reverted) {
    let usdAmtIn = formatBalance(event.params.usdAmtIn, vault.usdDecimals)
    let valueIn = usdAmtIn.times(vault.usdPrice)
    let estMintAmt = formatBalance(r.value, vault.decimals)
    let mintAmt = valueIn.div(vault.tvl).times(vault.totalSupply)
    let feePerc = estMintAmt.minus(mintAmt).div(estMintAmt)

    let usdClaimPost = vault.usdBal.times(estMintAmt).div(vault.totalSupply)
    let swapAmt = usdAmtIn.minus(usdClaimPost)
    let feeValue = swapAmt.times(feePerc)

    vault.swapNonce = vault.swapNonce.plus(BIGINT_ONE)
    vault.save()

    swap.type = 'usd'
    swap.swapAmt = swapAmt
    swap.swapValue = swap.swapAmt.times(vault.usdPrice)
    swap.tx = event.transaction.hash.toHex()
    swap.timestamp = event.block.timestamp
    swap.save()

    dailyStat.swapValue = dailyStat.swapValue.plus(swap.swapValue)
    dailyStat.feeValue = dailyStat.feeValue.plus(feeValue)
    dailyStat.feeYield = dailyStat.feeValue.div(dailyStat.tvl)
    dailyStat.save()

    swap.feeValue = feeValue
    swap.save()
  }
}

export function handleDepositPerp(event: DepositPerp): void {
  log.warning('triggered single sided deposit', [])
  let vault = fetchBillBroker(event.address)
  let dailyStat = fetchBillBrokerDailyStat(vault, dayTimestamp(event.block.timestamp))
  let swap = fetchBillBrokerSwap(vault, vault.swapNonce.plus(BIGINT_ONE))
  refreshBillBrokerStats(vault, dailyStat)

  vault.perpPrice = formatBalance(event.params.preOpState.perpPrice, vault.decimals)
  vault.usdPrice = formatBalance(event.params.preOpState.usdPrice, vault.decimals)
  vault.tvl = vault.usdBal.times(vault.usdPrice).plus(vault.perpBal.times(vault.perpPrice))
  vault.price = vault.tvl.div(vault.totalSupply)
  vault.save()

  dailyStat.perpPrice = vault.perpPrice
  dailyStat.usdPrice = vault.usdPrice
  dailyStat.tvl = vault.tvl
  dailyStat.price = vault.price
  dailyStat.save()

  let vaultContract = BillBrokerABI.bind(stringToAddress(vault.id))
  let reserveStateValues: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpBalance),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.usdPrice),
    ethereum.Value.fromUnsignedBigInt(event.params.preOpState.perpPrice),
  ]
  let reserveStateTuple = changetype<ethereum.Tuple>(reserveStateValues)
  let reserveStateStruct = changetype<BillBroker__computeMintAmtWithPerp1InputSStruct>(
    reserveStateTuple,
  )
  let r = vaultContract.try_computeMintAmtWithPerp1(event.params.perpAmtIn, reserveStateStruct)
  if (!r.reverted) {
    let perpAmtIn = formatBalance(event.params.perpAmtIn, vault.perpDecimals)
    let valueIn = perpAmtIn.times(vault.perpPrice)
    let estMintAmt = formatBalance(r.value, vault.decimals)
    let mintAmt = valueIn.div(vault.tvl).times(vault.totalSupply)
    let feePerc = estMintAmt.minus(mintAmt).div(estMintAmt)

    let perpClaimPost = vault.perpBal.times(estMintAmt).div(vault.totalSupply)
    let swapAmt = perpAmtIn.minus(perpClaimPost)
    let feeValue = swapAmt.times(feePerc)

    vault.swapNonce = vault.swapNonce.plus(BIGINT_ONE)
    vault.save()

    swap.type = 'perp'
    swap.swapAmt = swapAmt
    swap.swapValue = swap.swapAmt.times(vault.perpPrice)
    swap.tx = event.transaction.hash.toHex()
    swap.timestamp = event.block.timestamp
    swap.save()

    dailyStat.swapValue = dailyStat.swapValue.plus(swap.swapValue)
    dailyStat.feeValue = dailyStat.feeValue.plus(feeValue)
    dailyStat.feeYield = dailyStat.feeValue.div(dailyStat.tvl)
    dailyStat.save()

    swap.feeValue = feeValue
    swap.save()
  }
}
