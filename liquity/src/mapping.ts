import { BigInt, log, Address, ethereum } from "@graphprotocol/graph-ts"
import {
  Transfer
} from "../generated/VST/VST"
import {
  Transfer as TransferBAMM, RebalanceSwap
} from "../generated/BAMM/BAMM" 
import {
  Liquidation
} from "../generated/troveManager/troveManager"
import {
  Swap
} from "../generated/UniswapV2PairDAI/UniswapV2Pair"
import { Bamm, StabilityPool, LiquidationEvent, TokenSushiTrade, BammHour } from "../generated/schema"


const arbitrum_vesta_gOHM_bamm = "0x00FF66AB8699AAfa050EE5EF5041D1503aa0849a".toLowerCase()
const gOHM_sp = "0x66017D22b0f8556afDd19FC67041899Eb65a21bb".toLowerCase()
const address_zero = "0x0000000000000000000000000000000000000000"
const gOHM = "LUSD".toLowerCase()
const _1e18 = BigInt.fromString("1000000000000000000")
const zero = BigInt.fromString('0')

function getBamm (id: string): Bamm {

  let bamm = Bamm.load(id.toLowerCase())
  if(!bamm){
    bamm = new Bamm(id)
    bamm.TVL = BigInt.fromString("0")
    bamm.totalLiquidations = BigInt.fromString("0")
    bamm.collateralImbalance = BigInt.fromString("0")
    bamm.bammSupply = BigInt.fromString("0")
  }
  return bamm
}

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

  let bamm = getBamm(bammAddress)

  if(deposit){
    bamm.TVL = bamm.TVL.plus(event.params.value)
  }
  if(withdraw){
    bamm.TVL = bamm.TVL.minus(event.params.value)
  }

  bamm.save()
  updateHourlyData(event)
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
  updateHourlyData(event)
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
  liq.date = event.block.timestamp
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
  sp.save()
  if(liq.spTvl.gt(zero)){ // no SP TVL no BAMM TVL
    // bamm total liquidations 
    const bammLiqSize = liq.debtAmount.times(liq.bammTvl).div(liq.spTvl)
    const bammImbSize = liq.collateralAmount.times(liq.bammTvl).div(liq.spTvl)

    let bamm = getBamm(liq.bammId)
    bamm.TVL = bamm.TVL.minus(bammLiqSize)
    bamm.totalLiquidations = bamm.totalLiquidations.plus(bammLiqSize)
    bamm.collateralImbalance = bamm.collateralImbalance.plus(bammImbSize)
    bamm.save()
    updateHourlyData(event)
  }
}

export function handleTransfer(event: Transfer): void {
  checkForSpLiquidation(event, arbitrum_vesta_gOHM_bamm, gOHM_sp) // requires TVL state prior to transfer
  checkForBammDepositWithdraw(event, arbitrum_vesta_gOHM_bamm, gOHM_sp) // bamm tvl
  checkForSpTransfers(event, gOHM_sp) // sp tvl
}

export function handleLiquidation(event: Liquidation): void {
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



function getTokenSushiTrade (id: string): TokenSushiTrade {
  let tokenSushiTrade = TokenSushiTrade.load(id)
  if(!tokenSushiTrade){
    tokenSushiTrade = new TokenSushiTrade(id)
    tokenSushiTrade.token2EthPrice = BigInt.fromString("0")
    tokenSushiTrade.token2UsdPrice = BigInt.fromString("0")
  }
  return tokenSushiTrade
}

export function handlegDAISushiTrade(event: Swap): void {
  const daiAmount = event.params.amount0In.plus(event.params.amount0Out)
  const ethAmount = event.params.amount1In.plus(event.params.amount1Out)
  
  if(ethAmount.gt(zero)){
    const tokenSushiTrade = getTokenSushiTrade(gOHM)
    tokenSushiTrade.token2UsdPrice = daiAmount.times(_1e18).div(ethAmount)
    tokenSushiTrade.save()
    updateHourlyData(event)
  }
}

export function handleBAMMTokenTransfer(event: TransferBAMM): void {

  const bamm = getBamm(arbitrum_vesta_gOHM_bamm)
  const currentSupply = bamm.bammSupply
  const value = event.params._value
  if(event.params._from.toHexString() == address_zero) {
    // mint
    bamm.bammSupply = currentSupply.plus(value)
  }
  if(event.params._to.toHexString() == address_zero) {
    // burn
    // update imbalance
    let imbalance = bamm.collateralImbalance
    imbalance = imbalance.times(currentSupply.minus(value)).div(currentSupply)

    bamm.collateralImbalance = imbalance
    bamm.bammSupply = currentSupply.minus(value)
  }

  bamm.save()
  updateHourlyData(event)
}

export function handleRebalanceSwap(event: RebalanceSwap): void {
  const bamm = getBamm(arbitrum_vesta_gOHM_bamm)
  bamm.collateralImbalance = bamm.collateralImbalance.minus(event.params.ethAmount)
  bamm.save()

  updateHourlyData(event)
}

function updateHourlyData(event: ethereum.Event): void {
  const timestamp = event.block.timestamp.toI32()
  const timeId = timestamp / (60 * 60)

  let bammHour = BammHour.load(timeId.toString())
  if(!bammHour){
    bammHour = new BammHour(timeId.toString())
  }

  const bamm = getBamm(arbitrum_vesta_gOHM_bamm)
  const sushiTrade = getTokenSushiTrade(gOHM)

  bammHour.liquidations = bamm.totalLiquidations

  const bammLUSD = bamm.TVL
  const bammCollateral = bamm.collateralImbalance
  const bammCollateralInUSD = bammCollateral.times(sushiTrade.token2UsdPrice).div(_1e18)

  bammHour.USDTVL = bammCollateralInUSD.plus(bammLUSD)
  bammHour.collateralUSD = bammCollateralInUSD
  if(bamm.bammSupply.gt(zero)) {
    bammHour.LPTokenValue = bammHour.USDTVL.times(_1e18).div(bamm.bammSupply)
  }

  bammHour.save()
}
