import { BigInt, log, Address, ethereum } from "@graphprotocol/graph-ts"
import {
  Transfer
} from "../generated/VST/VST"
import {
  Liquidation
} from "../generated/troveManager/troveManager"
import { Bamm, StabilityPool, LiquidationEvent, BalanceChange } from "../generated/schema"

const arbitrum_vesta_gOHM_bamm = "0xebf8252756268091e523e57D293c0522B8aFe66b".toLowerCase()
const gOHM_sp = "0x6e53D20d674C27b858a005Cf4A72CFAaf4434ECB".toLowerCase()
const address_zero = "0x0000000000000000000000000000000000000000"
const gOHM = "0x8D9bA570D6cb60C7e3e0F31343Efe75AB8E65FB1".toLowerCase()

function checkForBammDepositWithdraw (event: Transfer, bammAddress: string, spAddress: string): void {
  const src = event.params.from.toHexString().toLowerCase()
  const dst = event.params.to.toHexString().toLowerCase()
  const deposit = (dst == bammAddress && src != spAddress)
  const withdraw = (src == bammAddress && dst != spAddress)
  if(dst == bammAddress || src == bammAddress){
    log.debug('--- handleTransfer deposit: {}  withdraw: {} bamm: {} sp: {} src: {} dst: {}', [deposit.toString(), withdraw.toString(),bammAddress, spAddress, src, dst])
  }
  if(!deposit && !withdraw){
    return // exit
  }
  let balanceChange = new BalanceChange(`${event.block.number.toString()}_${event.transactionLogIndex.toString()}_${event.logIndex.toString()}`)
  balanceChange.blockNumber = event.block.number
  balanceChange.amount = event.params.value
  balanceChange.txHash = event.transaction.hash.toHexString()
  let bamm = Bamm.load(bammAddress)
  if(!bamm){
    bamm = new Bamm(bammAddress)
    bamm.TVL = BigInt.fromString("0")
    bamm.totalLiquidations = BigInt.fromString("0")
  }

  if(deposit){
    balanceChange.type = "deposit"
    bamm.TVL = bamm.TVL.plus(balanceChange.amount)
  }
  if(withdraw){
    balanceChange.type = "withdraw"
    bamm.TVL = bamm.TVL.minus(balanceChange.amount)
  }

  balanceChange.save()
  bamm.save()
}

function checkForSpTransfers (event: Transfer, spAddress: string): void {
  const src = event.params.from.toHexString().toLowerCase()
  const dst = event.params.to.toHexString().toLowerCase()
  const deposit = (dst == spAddress)
  const withdraw = (src == spAddress)
  if(!deposit && !withdraw){
    return // exit
  }
  let sp = StabilityPool.load(spAddress)
  if(!sp){
    sp = new StabilityPool(spAddress)
    sp.TVL = BigInt.fromString("0")
    sp.totalLiquidations = BigInt.fromString("0")
  }
  if(deposit){
    sp.TVL = sp.TVL.plus(event.params.value)
  }
  if(withdraw){
    sp.TVL = sp.TVL.minus(event.params.value)
  }

  sp.save()
  
}

function checkForSpLiquidation (event: Transfer, bammAddress: string, spAddress: string) : void {
  const src = event.params.from.toHexString().toLowerCase()
  const dst = event.params.to.toHexString().toLowerCase()
  const liquidation = (src == spAddress && dst == address_zero)
  if(!liquidation){
    return // exit
  }
  // store the tvl state into liquidationTx2TvlStateMap
  const txHash = event.transaction.hash.toHexString()
  let liq = LiquidationEvent.load(txHash)
  if(!liq){
    liq = new LiquidationEvent(txHash)
  }
  liq.spId = spAddress
  const sp = StabilityPool.load(spAddress)
  if(!sp){
    return // exit
  }
  liq.spTvl = sp.TVL
  liq.bammId = bammAddress
  const bamm = Bamm.load(bammAddress)
  if(!bamm){
    return // exit
  }
  liq.bammTvl = bamm.TVL
  liq.save() // saving the liquidation only if bamm exists
  tryToSubtractLiquidationFromBamm(event, liq)
}

function tryToSubtractLiquidationFromBamm(event: ethereum.Event, liq: LiquidationEvent): void {

  if(!liq.bammTvl || !liq.debtAmount){
    return //exit
  }
  // sp total liquidations
  let sp = StabilityPool.load(liq.spId)
  if(!sp){
    sp = new StabilityPool(liq.spId)
    sp.TVL = BigInt.fromString("0")
    sp.totalLiquidations = BigInt.fromString("0")
  }
  sp.totalLiquidations = sp.totalLiquidations.plus(liq.debtAmount)
  sp.save
  
  // bamm total liquidations 
  const bammLiqSize = liq.debtAmount.times(liq.bammTvl).div(liq.spTvl)

  const balanceChange = new BalanceChange(`${event.block.number.toString()}_${event.transactionLogIndex.toString()}_${event.logIndex.toString()}`)
  balanceChange.blockNumber = event.block.number
  balanceChange.amount = bammLiqSize
  balanceChange.txHash = event.transaction.hash.toHexString()
  balanceChange.type = "liquidation"
  balanceChange.save()
  let bamm = Bamm.load(liq.bammId)
  if(!bamm){
    bamm = new Bamm(liq.bammId)
    bamm.TVL = BigInt.fromString("0")
    bamm.totalLiquidations = BigInt.fromString("0")
  }
  bamm.TVL = bamm.TVL.minus(balanceChange.amount)
  bamm.totalLiquidations = bamm.totalLiquidations.plus(balanceChange.amount)
  bamm.save()
}

export function handleTransfer(event: Transfer): void {
  checkForSpLiquidation(event, arbitrum_vesta_gOHM_bamm, gOHM_sp) // requires TVL state prior to transfer
  checkForBammDepositWithdraw(event, arbitrum_vesta_gOHM_bamm, gOHM_sp) // bamm tvl
  checkForSpTransfers(event, gOHM_sp) // sp tvl
}


export function handleLiquidation(event: Liquidation): void {
  if(event.params._asset.toHexString() != gOHM){
    return // exit
  }
  const txHash = event.transaction.hash.toHexString()
  let liq = LiquidationEvent.load(txHash)
  if(!liq){
    liq = new LiquidationEvent(txHash)
  }
  liq.debtAmount = event.params._liquidatedDebt
  liq.collateralAmount = event.params._liquidatedColl
  liq.save()
  tryToSubtractLiquidationFromBamm(event, liq)
}