import { BigInt, Address, ethereum, DataSourceContext } from '@graphprotocol/graph-ts'
import {
  BondFactory,
  BondController,
  Tranche,
  Token,
  AccountTrancheValue,
} from '../../generated/schema'
import { BondController as BondControllerABI } from '../../generated/BondFactory/BondController'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import {
  BondController as BondControllerTemplate,
  RebasingToken as RebasingTokenTemplate,
} from '../../generated/templates'
import { BIGINT_ZERO, BIGDECIMAL_ZERO, stringToAddress, formatBalance } from '../utils'
import { fetchToken, refreshSupply } from './token'

export function fetchBondFactory(address: Address): BondFactory {
  let id = address.toHexString()
  let factory = BondFactory.load(id)
  if (factory == null) {
    factory = new BondFactory(id)
    factory.bondCount = BIGINT_ZERO
    factory.save()
  }
  return factory as BondFactory
}

export function fetchBond(address: Address): BondController {
  let id = address.toHexString()
  let bond = BondController.load(id)
  if (bond == null) {
    let bondContract = BondControllerABI.bind(address)
    bond = new BondController(id)
    bond.collateral = fetchToken(bondContract.collateralToken()).id
    bond.creationDate = bondContract.creationDate()
    bond.maturityDate = bondContract.maturityDate()
    bond.isMature = bondContract.isMature()
    bond.totalDebt = BIGDECIMAL_ZERO
    bond.totalCollateral = BIGDECIMAL_ZERO
    let trancheCount = bondContract.trancheCount().toI32()
    let tranches: string[] = []
    for (let i = 0; i < trancheCount; i++) {
      let tranche = fetchTranche(bond as BondController, i)
      tranches.push(tranche.id)
    }
    bond.tranches = tranches
    bond.save()

    BondControllerTemplate.create(address)

    let collateralContext = new DataSourceContext()
    collateralContext.setString('bond', id)
    RebasingTokenTemplate.createWithContext(stringToAddress(bond.collateral), collateralContext)
  }
  return bond as BondController
}

export function fetchTranche(bond: BondController, trancheIndex: number): Tranche {
  let bondAddress = stringToAddress(bond.id)
  let bondContract = BondControllerABI.bind(bondAddress)
  let trancheResult = bondContract.try_tranches(BigInt.fromI32(trancheIndex as i32))
  if (trancheResult.reverted) {
    throw new Error('Unable to fetch tranche')
  }
  let address = trancheResult.value.value0
  let id = address.toHexString()
  let tranche = Tranche.load(id)
  if (tranche === null) {
    tranche = new Tranche(id)
    tranche.bond = bond.id
    tranche.token = fetchToken(address).id
    tranche.index = BigInt.fromI32(trancheIndex as i32)
    tranche.ratio = trancheResult.value.value1
    tranche.totalCollateral = BIGDECIMAL_ZERO
    tranche.save()
  }
  return tranche as Tranche
}

export function refreshBond(bond: BondController): void {
  let bondAddress = stringToAddress(bond.id)
  let bondContract = BondControllerABI.bind(bondAddress)
  let collateralAddress = stringToAddress(bond.collateral)
  let collateralContract = ERC20ABI.bind(collateralAddress)
  let collateral = fetchToken(collateralAddress)
  refreshSupply(collateral)

  bond.totalDebt = formatBalance(bondContract.totalDebt(), collateral.decimals)
  bond.totalCollateral = formatBalance(
    collateralContract.balanceOf(bondAddress),
    collateral.decimals,
  )

  let tranches = bond.tranches
  for (let i = 0; i < tranches.length; i++) {
    let tranche = fetchTranche(bond, i)
    let trancheAddress = stringToAddress(tranche.id)
    let trancheContract = ERC20ABI.bind(trancheAddress)
    let trancheToken = fetchToken(trancheAddress)
    refreshSupply(trancheToken)

    tranche.totalCollateral = formatBalance(
      collateralContract.balanceOf(trancheAddress),
      collateral.decimals,
    )

    trancheToken.save()
    tranche.save()
  }

  collateral.save()
  bond.save()
}

export function matureBond(bond: BondController, block: ethereum.Block): void {
  bond.isMature = true
  bond.maturedDate = block.timestamp
  bond.totalDebtAtMaturity = bond.totalDebt

  let totalCollateralAtMaturity = BIGDECIMAL_ZERO
  let tranches = bond.tranches
  for (let i = 0; i < tranches.length; i++) {
    let tranche = fetchTranche(bond, i)
    let trancheAddress = stringToAddress(tranche.id)
    let trancheToken = fetchToken(trancheAddress)

    totalCollateralAtMaturity = totalCollateralAtMaturity.plus(tranche.totalCollateral)

    tranche.totalSupplyAtMaturity = trancheToken.totalSupply
    tranche.totalCollateralAtMaturity = tranche.totalCollateral
    tranche.save()
  }

  bond.totalCollateralAtMaturity = totalCollateralAtMaturity
  bond.save()
}

export function fetchAccountTrancheValue(
  accountAddress: Address,
  trancheAddress: Address,
): AccountTrancheValue {
  let accountId = accountAddress.toHexString()
  let trancheId = trancheAddress.toHexString()
  let id = accountId.concat('-').concat(trancheId)
  let trancheValueInfo = AccountTrancheValue.load(id)
  if (trancheValueInfo === null) {
    trancheValueInfo = new AccountTrancheValue(id)
    trancheValueInfo.isBondMature = false
    trancheValueInfo.isSeniorTranche = false
    trancheValueInfo.trancheSupply = BIGDECIMAL_ZERO
    trancheValueInfo.bondCollateralBalance = BIGDECIMAL_ZERO
    trancheValueInfo.bondTotalDebt = BIGDECIMAL_ZERO
    trancheValueInfo.trancheClaim = BIGDECIMAL_ZERO
    trancheValueInfo.trancheCDR = BIGDECIMAL_ZERO
    trancheValueInfo.bondCDR = BIGDECIMAL_ZERO
    trancheValueInfo.tranchePrice = BIGDECIMAL_ZERO
    trancheValueInfo.trancheValue = BIGDECIMAL_ZERO
    trancheValueInfo.save()
  }
  return trancheValueInfo as AccountTrancheValue
}
