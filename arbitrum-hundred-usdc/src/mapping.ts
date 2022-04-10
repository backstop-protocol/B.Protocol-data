import { BigInt, log, Address, ethereum } from "@graphprotocol/graph-ts"
import {
  LiquidateBorrowCall, UserDeposit, UserWithdraw, RebalanceSwap
} from "../generated/BAMM/BAMM"
import {
  Redeem
} from "../generated/CToken/ctoken" 
import {
  Swap
} from "../generated/UniswapV2PairDAI/UniswapV2Pair" 

import { Bamm, LiquidationEvent, TokenSushiTrade, BammHour } from "../generated/schema"

const bammId = "0x04208f296039f482810B550ae0d68c3E1A5EB719".toLowerCase()
const _1e18 = BigInt.fromString("1000000000000000000")
const decimalsFactor = BigInt.fromString("10").pow(18 - 6) // usdc has 6 decimals
const zero = BigInt.fromString('0')

function getBamm (): Bamm {
  let bamm = Bamm.load(bammId)
  if(!bamm){
    bamm = new Bamm(bammId)
  }
  return bamm
}

export function handleDeposit(event: UserDeposit): void {
  const bamm = getBamm()

  bamm.TVL = bamm.TVL.plus(event.params.lusdAmount)
  bamm.bammSupply = bamm.bammSupply.plus(event.params.numShares)
  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleWithdraw(event: UserWithdraw): void {
  const bamm = getBamm()

  bamm.TVL = bamm.TVL.minus(event.params.lusdAmount)
  bamm.collateralImbalance = bamm.collateralImbalance.minus(event.params.ethAmount)
  bamm.bammSupply = bamm.bammSupply.minus(event.params.numShares)
 
  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleRebalance(event: RebalanceSwap): void {
  const bamm = getBamm()

  bamm.TVL = bamm.TVL.plus(event.params.lusdAmount)
  bamm.collateralImbalance = bamm.collateralImbalance.minus(event.params.ethAmount)
 
  bamm.save()
  updateHourlyData(event.block.timestamp)
}

export function handleLiquidationCall(call: LiquidateBorrowCall): void {
  const liquidationId = call.transaction.hash.toHexString()
  const liquidation = new LiquidationEvent(liquidationId)
  
  liquidation.blockNumber = call.block.number
  liquidation.debtAmount = call.inputs.amount
  liquidation.date = call.block.timestamp

  liquidation.save()

  const bamm = getBamm()

  bamm.TVL = bamm.TVL.minus(call.inputs.amount)
  bamm.totalLiquidations = bamm.totalLiquidations.plus(call.inputs.amount)

  bamm.save()
  updateHourlyData(call.block.timestamp)  
}

export function handleCTokenRedeem(event: Redeem): void {
  const bamm = getBamm()

  bamm.collateralImbalance = bamm.collateralImbalance.plus(event.params.redeemAmount)

  bamm.save()
  updateHourlyData(event.block.timestamp)  
}

function getTokenSushiTrade (): TokenSushiTrade {
  const id = bammId
  let tokenSushiTrade = TokenSushiTrade.load(id)
  if(!tokenSushiTrade){
    tokenSushiTrade = new TokenSushiTrade(id)
    tokenSushiTrade.token2EthPrice = BigInt.fromString("0")
    tokenSushiTrade.token2UsdPrice = BigInt.fromString("0")
  }
  return tokenSushiTrade
}

export function handlegDAISushiTrade(event: Swap): void {
  const ethAmount = event.params.amount0In.plus(event.params.amount0Out)
  const daiAmount = event.params.amount1In.plus(event.params.amount1Out)

  const tokenSushiTrade = getTokenSushiTrade()

  tokenSushiTrade.token2UsdPrice = daiAmount.times(_1e18).div(ethAmount)

  tokenSushiTrade.save()
  updateHourlyData(event.block.timestamp)
}


function updateHourlyData(timestampBigInt: BigInt): void {
  const timestamp = timestampBigInt.toI32()
  const timeId = timestamp / (60 * 60)

  let bammHour = BammHour.load(timeId.toString())
  if(!bammHour){
    bammHour = new BammHour(timeId.toString())
  }

  const bamm = getBamm()
  const sushiTrade = getTokenSushiTrade()

  const deposits = bamm.TVL
  const collateralImbalance = bamm.collateralImbalance
  const totalSupply = bamm.bammSupply
  const totalLiquidations = bamm.totalLiquidations

  const imbalanceInUSD = collateralImbalance.times(sushiTrade.token2UsdPrice).div(_1e18)
  const depositsInUSD = deposits.times(decimalsFactor)
  const tvl = imbalanceInUSD.plus(depositsInUSD)

  bammHour.USDTVL = tvl
  bammHour.collateralUSD = imbalanceInUSD
  bammHour.liquidations = totalLiquidations.times(decimalsFactor)
  bammHour.LPTokenValue = totalSupply.gt(zero) ? tvl.times(_1e18).div(totalSupply) : zero

  bammHour.save()
}
