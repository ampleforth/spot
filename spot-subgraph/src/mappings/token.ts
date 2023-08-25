import { BigInt } from '@graphprotocol/graph-ts'
import { Transfer } from '../../generated/templates/Token/ERC20'
import { fetchToken, fetchAccount, fetchAccountBalance } from '../data/token'
import { ADDRESS_ZERO, formatBalance } from '../utils'

export function handleTransfer(event: Transfer): void {
  let from = event.params.from
  let to = event.params.to
  let tokenAddress = event.address
  let token = fetchToken(tokenAddress)
  let amount = formatBalance(event.params.value, token.decimals)

  if (from != ADDRESS_ZERO) {
    let fromAccount = fetchAccount(from)
    let fromAccountBalance = fetchAccountBalance(from, tokenAddress)
    fromAccountBalance.amount = fromAccountBalance.amount.minus(amount)
    fromAccountBalance.block = event.block.number
    fromAccountBalance.modified = event.block.timestamp
    fromAccountBalance.transaction = event.transaction.hash
    fromAccountBalance.save()
  }

  if (to != ADDRESS_ZERO) {
    let toAccount = fetchAccount(to)
    let toAccountBalance = fetchAccountBalance(to, tokenAddress)
    toAccountBalance.amount = toAccountBalance.amount.plus(amount)
    toAccountBalance.block = event.block.number
    toAccountBalance.modified = event.block.timestamp
    toAccountBalance.transaction = event.transaction.hash
    toAccountBalance.save()
  }

  if (from == ADDRESS_ZERO && to != ADDRESS_ZERO) {
    token.totalSupply = token.totalSupply.plus(amount)
    token.save()
  }

  if (from != ADDRESS_ZERO && to == ADDRESS_ZERO) {
    token.totalSupply = token.totalSupply.minus(amount)
    token.save()
  }
}
