import { BigInt, BigDecimal, Address, DataSourceContext } from '@graphprotocol/graph-ts'
import {
  PerpetualTranche,
  PerpetualTrancheReserveAsset,
  PerpetualTrancheDailyStat,
} from '../../generated/schema'
import { PerpetualTranche as PerpetualTrancheABI } from '../../generated/PerpetualTranche/PerpetualTranche'
import { PerpetualTrancheV1 as PerpetualTrancheABIV1 } from '../../generated/PerpetualTranche/PerpetualTrancheV1'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import { RebasingToken as RebasingTokenTemplate } from '../../generated/templates'
import {
  ADDRESS_ZERO,
  BIGDECIMAL_ZERO,
  stringToAddress,
  formatBalance,
  getTrancheCDRInfo,
} from '../utils'
import { fetchToken, refreshSupply } from './token'
import { fetchAccountTrancheValue } from './buttonTranche'

function getUnderlyingAddress(perpAddress: Address): Address {
  let perpContract = PerpetualTrancheABI.bind(perpAddress)
  let r = perpContract.try_underlying()
  let underlyingAddress: Address
  if (r.reverted) {
    let perpContractV1 = PerpetualTrancheABIV1.bind(perpAddress)
    underlyingAddress = perpContractV1.collateral()
  } else {
    underlyingAddress = r.value
  }
  return underlyingAddress
}

export function refreshPerpetualTrancheStore(perp: PerpetualTranche): void {
  let perpAddress = stringToAddress(perp.id)
  let perpToken = fetchToken(perpAddress)
  refreshSupply(perpToken)

  let perpContract = PerpetualTrancheABI.bind(perpAddress)
  let underlyingAddress = getUnderlyingAddress(perpAddress)
  let underlyingERC20Contract = ERC20ABI.bind(underlyingAddress)

  let underlying = fetchToken(underlyingAddress)
  underlying.save()

  perp.underlying = underlying.id
  perp.save()

  let reserveUnderlying = fetchPerpetualTrancheReserveAsset(perpAddress, underlyingAddress)
  reserveUnderlying.balance = formatBalance(
    underlyingERC20Contract.balanceOf(perpAddress),
    perpToken.decimals,
  )
  reserveUnderlying.save()
}

export function refreshPerpetualTrancheTVL(perp: PerpetualTranche): void {
  let perpAddress = stringToAddress(perp.id)
  let perpToken = fetchToken(perpAddress)
  refreshSupply(perpToken)

  let perpContract = PerpetualTrancheABI.bind(perpAddress)
  let underlyingAddress = getUnderlyingAddress(perpAddress)
  let underlyingERC20Contract = ERC20ABI.bind(underlyingAddress)
  let underlyingBalance = formatBalance(
    underlyingERC20Contract.balanceOf(perpAddress),
    perpToken.decimals,
  )

  let activeReserves = perp.activeReserves
  let tvl = BIGDECIMAL_ZERO
  for (let i = 0; i < activeReserves.length; i++) {
    let tokenAddress = stringToAddress(activeReserves[i].split('-')[1])
    let reserveAsset = fetchPerpetualTrancheReserveAsset(perpAddress, tokenAddress)
    let tokenContract = ERC20ABI.bind(tokenAddress)
    let tokenBalance = formatBalance(tokenContract.balanceOf(perpAddress), perpToken.decimals)
    reserveAsset.balance = tokenBalance
    if (tokenAddress == underlyingAddress) {
      tvl = tvl.plus(tokenBalance)
    } else {
      let r = getTrancheCDRInfo(tokenAddress, underlyingAddress, tokenBalance)
      let reserveTrancheValue = fetchAccountTrancheValue(perpAddress, tokenAddress)
      reserveTrancheValue.isBondMature = r.isBondMature
      reserveTrancheValue.isSeniorTranche = r.isSeniorTranche
      reserveTrancheValue.trancheSupply = r.trancheSupply
      reserveTrancheValue.bondCollateralBalance = r.bondCollateralBalance
      reserveTrancheValue.bondTotalDebt = r.bondTotalDebt
      reserveTrancheValue.trancheClaim = r.trancheClaim
      reserveTrancheValue.trancheCDR = r.trancheCDR
      reserveTrancheValue.bondCDR = r.bondCDR
      reserveTrancheValue.tranchePrice = r.tranchePrice
      reserveTrancheValue.trancheValue = r.trancheValue
      reserveTrancheValue.save()
      tvl = tvl.plus(r.trancheValue)
    }
    reserveAsset.save()
  }
  perp.tvl = tvl
  if (perpToken.totalSupply.gt(BIGDECIMAL_ZERO)) {
    perp.price = perp.tvl.div(perpToken.totalSupply)
  }
  perp.save()
}

export function refreshPerpetualTrancheDailyStat(dailyStat: PerpetualTrancheDailyStat): void {
  let perp = PerpetualTranche.load(dailyStat.perp)
  let perpToken = fetchToken(stringToAddress(dailyStat.perp))
  refreshSupply(perpToken)
  dailyStat.tvl = perp.tvl
  dailyStat.price = perp.price
  dailyStat.totalSupply = perpToken.totalSupply
  dailyStat.save()
}

export function fetchPerpetualTranche(address: Address): PerpetualTranche {
  let id = address.toHexString()
  let perp = PerpetualTranche.load(id)
  if (perp == null) {
    let perpToken = fetchToken(address)
    perpToken.save()

    perp = new PerpetualTranche(id)
    perp.token = perpToken.id
    perp.depositBond = null
    perp.activeReserves = []
    perp.tvl = BIGDECIMAL_ZERO
    perp.price = BIGDECIMAL_ZERO
    refreshPerpetualTrancheStore(perp as PerpetualTranche)

    let collateralContext = new DataSourceContext()
    collateralContext.setString('perp', id)
    RebasingTokenTemplate.createWithContext(stringToAddress(perp.underlying), collateralContext)
    perp.save()
  }
  return perp as PerpetualTranche
}

export function fetchPerpetualTrancheReserveAsset(
  perpAddress: Address,
  tokenAddress: Address,
): PerpetualTrancheReserveAsset {
  let perpId = perpAddress.toHexString()
  let tokenId = tokenAddress.toHexString()
  let id = perpId.concat('-').concat(tokenId)
  let reserveToken = PerpetualTrancheReserveAsset.load(id)
  if (reserveToken === null) {
    let perpContract = PerpetualTrancheABI.bind(perpAddress)
    let underlyingAddress = getUnderlyingAddress(perpAddress)
    reserveToken = new PerpetualTrancheReserveAsset(id)
    reserveToken.perp = perpId
    reserveToken.token = tokenId
    reserveToken.balance = BIGDECIMAL_ZERO
    // if the reserve asset isn't the underlying collateral, we infer its a tranche
    if (tokenAddress != underlyingAddress) {
      reserveToken.tranche = tokenId
      let reserveTrancheValue = fetchAccountTrancheValue(perpAddress, tokenAddress)
      reserveTrancheValue.save()
      reserveToken.value = reserveTrancheValue.id
    }
    reserveToken.save()
  }
  return reserveToken as PerpetualTrancheReserveAsset
}

export function fetchPerpetualTrancheDailyStat(
  perp: PerpetualTranche,
  timestamp: BigInt,
): PerpetualTrancheDailyStat {
  let id = perp.id.concat('-').concat(timestamp.toString())
  let dailyStat = PerpetualTrancheDailyStat.load(id)
  if (dailyStat === null) {
    dailyStat = new PerpetualTrancheDailyStat(id)
    dailyStat.perp = perp.id
    dailyStat.timestamp = timestamp
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
    dailyStat.totalUnderlyingFeeValue = BIGDECIMAL_ZERO
  }
  return dailyStat as PerpetualTrancheDailyStat
}
