import { BigInt, Address } from '@graphprotocol/graph-ts'
import { Token, Account, AccountBalance } from '../../generated/schema'
import { Token as TokenTemplate } from '../../generated/templates'
import { ERC20 as ERC20ABI } from '../../generated/BondFactory/ERC20'
import { BIGDECIMAL_ZERO, stringToAddress, formatBalance } from '../utils'

export function refreshSupply(token: Token): void {
  let tokenContract = ERC20ABI.bind(stringToAddress(token.id))
  token.totalSupply = formatBalance(tokenContract.totalSupply(), token.decimals)
  token.save()
}

export function fetchToken(address: Address): Token {
  let id = address.toHexString()
  let token = Token.load(id)
  if (token === null) {
    let tokenContract = ERC20ABI.bind(stringToAddress(id))
    token = new Token(id)
    token.symbol = tokenContract.symbol()
    token.name = tokenContract.name()
    token.decimals = BigInt.fromI32(tokenContract.decimals())
    token.totalSupply = BIGDECIMAL_ZERO
    token.save()
    TokenTemplate.create(address)
  }
  return token as Token
}

export function fetchAccount(address: Address): Account {
  let id = address.toHexString()
  let account = Account.load(id)
  if (account === null) {
    let account = new Account(id)
    account.save()
  }
  return account as Account
}

export function fetchAccountBalance(
  accountAddress: Address,
  tokenAddress: Address,
): AccountBalance {
  let accountId = accountAddress.toHexString()
  let tokenId = tokenAddress.toHexString()
  let id = accountId.concat('-').concat(tokenId)
  let balance = AccountBalance.load(id)
  if (balance === null) {
    balance = new AccountBalance(id)
    balance.account = accountId
    balance.token = tokenId
    balance.amount = BIGDECIMAL_ZERO
    balance.save()
  }
  return balance as AccountBalance
}
