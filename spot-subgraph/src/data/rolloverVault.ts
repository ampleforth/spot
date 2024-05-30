import { BigDecimal, BigInt, Address, DataSourceContext } from '@graphprotocol/graph-ts'
import {
  RolloverVault,
  RolloverVaultAsset,
  ScaledUnderlyingVaultDepositorBalance,
  RolloverVaultDailyStat,
  Tranche
} from '../../generated/schema'
import { RolloverVault as RolloverVaultABI } from '../../generated/RolloverVault/RolloverVault'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import { RebasingToken as RebasingTokenTemplate } from '../../generated/templates'
import {
  ADDRESS_ZERO,
  BIGINT_ZERO,
  BIGDECIMAL_ZERO,
  BIGDECIMAL_ONE,
  stringToAddress,
  formatBalance,
  getTrancheCDRInfo,
} from '../utils'
import { fetchPerpetualTranche } from './perpetualTranche'
import { fetchAccountTrancheValue } from './buttonTranche'
import { fetchToken, refreshSupply } from './token'

export function refreshRolloverVaultStore(vault: RolloverVault): void {
  let vaultAddress = stringToAddress(vault.id)
  let vaultToken = fetchToken(vaultAddress)
  refreshSupply(vaultToken)

  let vaultContract = RolloverVaultABI.bind(vaultAddress)
  let underlyingAddress = vaultContract.underlying()
  let underlying = fetchToken(underlyingAddress)

  let perpAddress = vaultContract.perp()
  let perp = fetchPerpetualTranche(perpAddress)

  vault.underlying = underlying.id
  vault.perp = perp.id
  vault.save()

  let underlyingContract = ERC20ABI.bind(underlyingAddress)
  let underlyingAsset = fetchRolloverVaultAsset(vaultAddress, underlyingAddress)
  underlyingAsset.balance = formatBalance(
    underlyingContract.balanceOf(vaultAddress),
    vaultToken.decimals,
  )
  underlyingAsset.save()
}

export function refreshRolloverVaultTVL(vault: RolloverVault): void {
  let vaultAddress = stringToAddress(vault.id)
  let vaultContract = RolloverVaultABI.bind(vaultAddress)

  let vaultToken = fetchToken(vaultAddress)
  refreshSupply(vaultToken)

  let underlyingAddress = vaultContract.underlying()
  let perpAddress = vaultContract.perp()
  let underlyingToken = fetchToken(underlyingAddress)

  let activeReserves = vault.activeReserves
  let tvl = BIGDECIMAL_ZERO
  for (let i = 0; i < activeReserves.length; i++) {
    let tokenAddress = stringToAddress(activeReserves[i].split('-')[1])
    let reserveAsset = fetchRolloverVaultAsset(vaultAddress, tokenAddress)
    let tokenContract = ERC20ABI.bind(tokenAddress)
    let tokenBalance = formatBalance(
      tokenContract.balanceOf(vaultAddress),
      underlyingToken.decimals,
    )
    reserveAsset.balance = tokenBalance
    if (tokenAddress == underlyingAddress) {
      tvl = tvl.plus(tokenBalance)
    } else if (tokenAddress == perpAddress) {
      // do nothing
    } else {
      reserveAsset.balance = tokenBalance
      let r = getTrancheCDRInfo(tokenAddress, underlyingAddress, tokenBalance)
      let reserveTrancheValue = fetchAccountTrancheValue(vaultAddress, tokenAddress)
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
  vault.tvl = tvl
  if (vaultToken.totalSupply.gt(BIGDECIMAL_ZERO)) {
    vault.price = vault.tvl.div(vaultToken.totalSupply)
  }
  vault.save()
}

export function refreshRolloverVaultRebaseMultiplier(vault: RolloverVault): void {
  let vaultAddress = stringToAddress(vault.id)
  let underlyingAddress = stringToAddress(vault.underlying)
  let perpAddress = stringToAddress(vault.perp)
  let underlyingToken = fetchToken(underlyingAddress)

  let sumAs: BigDecimal = BIGDECIMAL_ZERO
  let sumZs: BigDecimal = BIGDECIMAL_ZERO
  let vaultUnderlyingBalance: BigDecimal = BIGDECIMAL_ZERO
  let vaultPerpBalance: BigDecimal = BIGDECIMAL_ZERO
  let vaultZBalance = BIGDECIMAL_ZERO
  let ONE_THOUSAND = BigDecimal.fromString('1000')

  let activeReserves = vault.activeReserves
  for (let i = 0; i < activeReserves.length; i++) {
    let tokenAddress = stringToAddress(activeReserves[i].split('-')[1])
    let tokenContract = ERC20ABI.bind(tokenAddress)
    let tokenBalance = formatBalance(
      tokenContract.balanceOf(vaultAddress),
      underlyingToken.decimals,
    )
    if (tokenAddress == underlyingAddress) {
      vaultUnderlyingBalance = tokenBalance
    } else if (tokenAddress == perpAddress) {
      vaultPerpBalance = tokenBalance
    } else {
      let tranche = Tranche.load(tokenAddress.toHexString())
      // junior tranche
      if (tranche.index.gt(BIGINT_ZERO)) {
        let zRatio = BigDecimal.fromString(tranche.ratio.toString()).div(ONE_THOUSAND)
        sumZs = sumZs.plus(tokenBalance.div(zRatio))
        vaultZBalance = vaultZBalance.plus(tokenBalance)
      }
      // senior tranche
      else {
        sumAs = sumAs.plus(tokenBalance)
      }
    }
  }

  let numerator = sumZs.plus(vaultUnderlyingBalance)
  let denominator = sumAs
    .plus(vaultPerpBalance)
    .plus(vaultZBalance)
    .plus(vaultUnderlyingBalance)
  if(denominator.gt(BIGDECIMAL_ZERO)){
    vault.rebaseMultiplier = numerator.div(denominator)
  }
  vault.save()  
}

export function refreshRolloverVaultDailyStat(dailyStat: RolloverVaultDailyStat): void {
  let vault = RolloverVault.load(dailyStat.vault)
  let vaultToken = fetchToken(stringToAddress(dailyStat.vault))
  dailyStat.tvl = vault.tvl
  dailyStat.rebaseMultiplier = vault.rebaseMultiplier
  dailyStat.price = vault.price
  dailyStat.totalSupply = vaultToken.totalSupply
  dailyStat.save()
}

export function fetchRolloverVault(address: Address): RolloverVault {
  let id = address.toHexString()
  let vault = RolloverVault.load(id)
  if (vault == null) {
    let vaultToken = fetchToken(address)
    vaultToken.save()
    vault = new RolloverVault(id)
    vault.token = vaultToken.id
    vault.totalScaledUnderlyingDeposited = BIGDECIMAL_ZERO
    vault.activeReserves = []
    vault.tvl = BIGDECIMAL_ZERO
    vault.rebaseMultiplier = BIGDECIMAL_ONE
    vault.price = BIGDECIMAL_ZERO
    refreshRolloverVaultStore(vault as RolloverVault)

    let underlyingContext = new DataSourceContext()
    underlyingContext.setString('vault', id)
    RebasingTokenTemplate.createWithContext(stringToAddress(vault.underlying), underlyingContext)
    vault.save()
  }

  return vault as RolloverVault
}

export function fetchRolloverVaultAsset(
  vaultAddress: Address,
  tokenAddress: Address,
): RolloverVaultAsset {
  let vaultId = vaultAddress.toHexString()
  let tokenId = tokenAddress.toHexString()
  let id = vaultId.concat('-').concat(tokenId)
  let assetToken = RolloverVaultAsset.load(id)
  if (assetToken === null) {
    let vaultContract = RolloverVaultABI.bind(vaultAddress)
    let underlyingAddress = vaultContract.underlying()
    let perpAddress = vaultContract.perp()
    assetToken = new RolloverVaultAsset(id)
    assetToken.vault = vaultId
    assetToken.token = tokenId
    assetToken.balance = BIGDECIMAL_ZERO
    // if the vault asset isn't perp or the underlying, we infer its a tranche
    if (tokenAddress != underlyingAddress && tokenAddress != perpAddress) {
      assetToken.tranche = tokenId
      let reserveTrancheValue = fetchAccountTrancheValue(vaultAddress, tokenAddress)
      reserveTrancheValue.save()
      assetToken.value = reserveTrancheValue.id
    }
    assetToken.save()
  }
  return assetToken as RolloverVaultAsset
}

export function fetchScaledUnderlyingVaultDepositorBalance(
  vault: RolloverVault,
  account: Address,
): ScaledUnderlyingVaultDepositorBalance {
  let id = vault.id.concat('-').concat(account.toHexString())
  let balance = ScaledUnderlyingVaultDepositorBalance.load(id)
  if (balance == null) {
    balance = new ScaledUnderlyingVaultDepositorBalance(id)
    balance.vault = vault.id
    balance.account = account
    balance.value = BIGDECIMAL_ZERO
  }
  return balance as ScaledUnderlyingVaultDepositorBalance
}

export function fetchRolloverVaultDailyStat(
  vault: RolloverVault,
  timestamp: BigInt,
): RolloverVaultDailyStat {
  let id = vault.id.concat('-').concat(timestamp.toString())
  let dailyStat = RolloverVaultDailyStat.load(id)
  if (dailyStat === null) {
    dailyStat = new RolloverVaultDailyStat(id)
    dailyStat.vault = vault.id
    dailyStat.timestamp = timestamp
    dailyStat.totalMints = BIGDECIMAL_ZERO
    dailyStat.totalRedemptions = BIGDECIMAL_ZERO
    dailyStat.totalMintValue = BIGDECIMAL_ZERO
    dailyStat.totalRedemptionValue = BIGDECIMAL_ZERO
    dailyStat.tvl = BIGDECIMAL_ZERO
    dailyStat.rebaseMultiplier = BIGDECIMAL_ONE
    dailyStat.price = BIGDECIMAL_ZERO
    dailyStat.totalSupply = BIGDECIMAL_ZERO
    dailyStat.totalSwapValue = BIGDECIMAL_ZERO
  }
  return dailyStat as RolloverVaultDailyStat
}
