import { BigInt, log, Address, ethereum } from "@graphprotocol/graph-ts"
import {
  LiquidateBorrowCall, UserDeposit, UserWithdraw, RebalanceSwap
} from "../generated/BAMM/BAMM"


import { Bamm, LiquidationEvent, BammHour } from "../generated/schema"

const bammId = "0x6d62d6Af9b82CDfA3A7d16601DDbCF8970634d22".toLowerCase()
const _1e18 = BigInt.fromString("1000000000000000000")
const decimalsFactor = BigInt.fromString("10").pow(18 - 18) // dai has 18 decimals

function getBamm (): Bamm {
  let bamm = Bamm.load(bammId)
  if(!bamm){
    bamm = new Bamm(bammId)
  }
  return bamm
}

export function handleDeposit(event: UserDeposit): void {
  const bamm = getBamm()

  bamm.deposits = bamm.deposits.plus(event.params.lusdAmount)
  bamm.bammSupply = bamm.bammSupply.plus(event.params.numShares)

  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleWithdraw(event: UserWithdraw): void {
  const bamm = getBamm()

  bamm.deposits = bamm.deposits.minus(event.params.lusdAmount)
  //bamm.collateralImbalance = bamm.collateralImbalance.minus(event.params.ethAmount)
  bamm.bammSupply = bamm.bammSupply.minus(event.params.numShares)
 
  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleRebalance(event: RebalanceSwap): void {
  const bamm = getBamm()

  bamm.deposits = bamm.deposits.plus(event.params.lusdAmount)
  //bamm.collateralImbalance = bamm.collateralImbalance.minus(event.params.ethAmount)
 
  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleLiquidationCall(call: LiquidateBorrowCall): void {
  const liquidationId = call.transaction.hash.toHexString() + ";" + call.transaction.index.toHexString()
  const liquidation = new LiquidationEvent(liquidationId)
  
  liquidation.blockNumber = call.block.number
  liquidation.debtAmount = call.inputs.amount
  liquidation.txHash = call.transaction.hash.toHexString()
  liquidation.date = call.block.timestamp
  liquidation.bammId = bammId
  liquidation.save()


  const bamm = getBamm()

  bamm.deposits = bamm.deposits.minus(call.inputs.amount)
  bamm.totalLiquidations = bamm.totalLiquidations.plus(call.inputs.amount)

  bamm.save()
  updateHourlyData(call.block.timestamp)  
}

function updateHourlyData(timestampBigInt: BigInt): void {
  const timestamp = timestampBigInt.toI32()
  const timeId = timestamp / (60 * 60)

  let bammHour = BammHour.load(timeId.toString())
  if(!bammHour){
    bammHour = new BammHour(timeId.toString())
  }

  const bamm = getBamm()

  const deposits = bamm.deposits
  const totalSupply = bamm.bammSupply
  const totalLiquidations = bamm.totalLiquidations

  const depositsInUSD = deposits.times(decimalsFactor)
  const tvl = (depositsInUSD)

  bammHour.USDTVL = tvl
  bammHour.liquidations = totalLiquidations.times(decimalsFactor)
  bammHour.LPTokenValue = tvl.times(_1e18).div(totalSupply)

  bammHour.save()
}
