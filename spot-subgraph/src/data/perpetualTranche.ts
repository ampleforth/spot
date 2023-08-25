import { BigInt, Address, DataSourceContext } from '@graphprotocol/graph-ts'
import {
  PerpetualTranche,
  PerpetualTrancheReserveAsset,
} from '../../generated/schema'
import { PerpetualTranche as PerpetualTrancheABI } from '../../generated/PerpetualTranche/PerpetualTranche'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import { RebasingToken as RebasingTokenTemplate } from '../../generated/templates'
import {
  ADDRESS_ZERO,
  BIGDECIMAL_ZERO,
  stringToAddress,
  formatBalance,
} from '../utils'
import { fetchToken } from './token'

export function refreshPerpetualTrancheStore(perp: PerpetualTranche): void {
  let address = stringToAddress(perp.id)
  let perpContract = PerpetualTrancheABI.bind(address)
  let decimals = BigInt.fromI32(perpContract.decimals())
  let collateralAddress = perpContract.collateral()
  let collateralContract = ERC20ABI.bind(collateralAddress)
  let collateral = fetchToken(collateralAddress)
  perp.collateral = collateral.id
  perp.owner = perpContract.owner().toHexString()
  perp.keeper = perpContract.keeper().toHexString()
  perp.issuer = perpContract.bondIssuer().toHexString()
  perp.feeStrategy = perpContract.feeStrategy().toHexString()
  perp.pricingStrategy = perpContract.pricingStrategy().toHexString()
  perp.discountStrategy = perpContract.discountStrategy().toHexString()
  perp.minTrancheMaturitySec = perpContract.minTrancheMaturitySec()
  perp.maxTrancheMaturitySec = perpContract.maxTrancheMaturitySec()
  perp.maxSupply = formatBalance(perpContract.maxSupply(), decimals)
  perp.maxMintAmtPerTranche = formatBalance(
    perpContract.maxMintAmtPerTranche(),
    decimals,
  )
  perp.matureValueTargetPerc = formatBalance(
    perpContract.matureValueTargetPerc(),
    BigInt.fromI32(2),
  )
  perp.save()

  let reserveCollateral = fetchPerpetualTrancheReserveAsset(
    address,
    collateralAddress,
  )
  reserveCollateral.balance = formatBalance(
    collateralContract.balanceOf(perpContract.reserve()),
    decimals,
  )
  reserveCollateral.save()
}

export function fetchPerpetualTranche(address: Address): PerpetualTranche {
  let id = address.toHexString()
  let perp = PerpetualTranche.load(id)
  if (perp == null) {
    let perpToken = fetchToken(address)
    perp = new PerpetualTranche(id)
    perp.token = perpToken.id
    perp.depositBond = null
    perp.matureTrancheBalance = BIGDECIMAL_ZERO
    refreshPerpetualTrancheStore(perp as PerpetualTranche)

    let collateralContext = new DataSourceContext()
    collateralContext.setString('perp', id)
    RebasingTokenTemplate.createWithContext(
      stringToAddress(perp.collateral),
      collateralContext,
    )
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
    let collateralAddress = perpContract.collateral()
    reserveToken = new PerpetualTrancheReserveAsset(id)
    reserveToken.perp = perpId
    reserveToken.token = tokenId
    reserveToken.balance = BIGDECIMAL_ZERO
    if (tokenAddress != collateralAddress) {
      reserveToken.tranche = tokenId
    }
    reserveToken.save()
  }
  return reserveToken as PerpetualTrancheReserveAsset
}
