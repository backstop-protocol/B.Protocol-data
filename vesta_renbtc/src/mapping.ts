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
} from "../generated/UniswapV2Pair/UniswapV2Pair"
import { Bamm, StabilityPool, LiquidationEvent, TokenSushiTrade, BammHour } from "../generated/schema"

const arbitrum_vesta_gOHM_bamm = "0x0a30963A461aa4eb4252b5a06525603E49034C41".toLowerCase()
const gOHM_sp = "0x3282dfAf0fBba4d3E771C4E5F669Cb4E14D8adb0".toLowerCase()
const address_zero = "0x0000000000000000000000000000000000000000"
const gOHM = "0xDBf31dF14B66535aF65AaC99C32e9eA844e14501".toLowerCase()
const _1e18 = BigInt.fromString("1000000000000000000")
const zero = BigInt.fromString('0')

function getBamm (id: string): Bamm {
  let bamm = Bamm.load(id)
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
  liq.date = event.block.timestamp
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

  if(!liq.bammTvl || !liq.spDebtAmount){
    return //exit
  }
  // sp total liquidations
  let sp = StabilityPool.load(liq.spId)
  if(!sp){
    sp = new StabilityPool(liq.spId)
    sp.TVL = BigInt.fromString("0")
    sp.totalLiquidations = BigInt.fromString("0")
  }
  sp.totalLiquidations = sp.totalLiquidations.plus(liq.spDebtAmount)
  sp.save()
  
  // bamm total liquidations 
  const bammLiqSize = liq.spDebtAmount.times(liq.bammTvl).div(liq.spTvl)
  const bammImbSize = liq.spCollateralAmount.times(liq.bammTvl).div(liq.spTvl)

  liq.debtAmount = liq.debtAmount.plus(bammLiqSize)
  liq.collateralAmount = liq.collateralAmount.plus(bammImbSize)
  liq.save()
  let bamm = getBamm(liq.bammId)
  bamm.TVL = bamm.TVL.minus(bammLiqSize)
  bamm.totalLiquidations = bamm.totalLiquidations.plus(bammLiqSize)
  bamm.collateralImbalance = bamm.collateralImbalance.plus(bammImbSize)
  bamm.save()
  updateHourlyData(event)
}

export function handleTransfer(event: Transfer): void {
  log.debug('test 123',[])  
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
    return // exit
  }
  liq.spDebtAmount = event.params._liquidatedDebt
  liq.spCollateralAmount = event.params._liquidatedColl
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

export function handlegOHMSushiTrade(event: Swap): void {
  const renBTCAmount = event.params.amount0In.plus(event.params.amount0Out)
  if(renBTCAmount.gt(zero)){
    const ethAmount = event.params.amount1In.plus(event.params.amount1Out)
    const price = ethAmount.times(_1e18).div(renBTCAmount)

    const tokenSushiTrade = getTokenSushiTrade(gOHM)
    tokenSushiTrade.token2EthPrice = price
    tokenSushiTrade.save()
    updateHourlyData(event)
  }
}

export function handlegDAISushiTrade(event: Swap): void {
  const ethAmount = event.params.amount0In.plus(event.params.amount0Out)
  const daiAmount = event.params.amount1In.plus(event.params.amount1Out)
  if(ethAmount.equals(zero)){
    log.debug('zero trade',[])  
    return
  }
  const tokenSushiTrade = getTokenSushiTrade(gOHM)

  tokenSushiTrade.token2UsdPrice = daiAmount.times(tokenSushiTrade.token2EthPrice).div(ethAmount)


  tokenSushiTrade.save()
  updateHourlyData(event)
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
  bammHour.LPTokenValue = bamm.bammSupply.gt(zero) ? bammHour.USDTVL.times(_1e18).div(bamm.bammSupply) : zero

  bammHour.save()
}
