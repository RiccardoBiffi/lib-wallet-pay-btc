const BitcoinPay = require('../src/wallet-pay-btc.js')
const { WalletStoreHyperbee } = require('lib-wallet-store')
const KeyManager = require('../src/wallet-key-btc.js')
const BIP39Seed = require('wallet-seed-bip39')
const Electrum = require('../src/electrum.js')
const BitcoinCore = require('../src/bitcoin-core.js')
const { bitcoin } = require('../../wallet-lib-test-tools/')
const BitcoinCurr = require('../src/currency')
const fs = require('fs')
const testconf = require('./test-conf.json')

async function electrumConnect(config = {}) {
  config.host = testconf.electrum.host || 'localhost'
  config.port = testconf.electrum.port || '8001'
  config.store = config.store || newStore()
  let e
  try {
    e = new Electrum(config)
    await e.connect()
  } catch (err) {
    console.log('Error connecting to Electrum:', err)
  }
  return e
}

async function bitcoinCoreConnect(config = {}) {
  config.host = testconf.bitcoinCore.host || 'localhost'
  config.port = testconf.bitcoinCore.port || '18443'
  config.user = testconf.bitcoinCore.user || 'bitcoin'
  config.pass = testconf.bitcoinCore.pass || 'local321'
  config.wallet = testconf.bitcoinCore.wallet || 'main.dat'
  config.zmqPort = testconf.bitcoinCore.zmqPort || '28334'
  config.store = config.store || newStore()
  let bc
  try {
    bc = new BitcoinCore(config)
    await bc.connect()
  } catch (err) {
    console.log('Error connecting to Bitcoin Core:', err)
  }
  return bc
}

const _datadir = './test-store'
function newStore(tmpStore) {
  return tmpStore
    ? new WalletStoreHyperbee({ store_path: _datadir })
    : new WalletStoreHyperbee()
}

let _regtest
async function regtestNode(opts = {}) {
  if (_regtest) return _regtest
  _regtest = new bitcoin.BitcoinCore({})
  await _regtest.init()
  if (!opts.mine) return _regtest
  await _regtest.mine({ blocks: 1 })
  return _regtest
}

/**
  * @description Create a new wallet isntance
  * @param {Boolean} config.newWallet generate a new wallet
  * @param {string} config.phrase seed phrase for a wallet
  * @param {Store} config.store an instance of a store
  * @param {boolean} config.tmpStore generate a temporary file store
  * @return {Promise<BitcoinPay>}
*/
async function activeWallet(config = {}) {
  const _store = newStore()
  let seed
  const phrase = 'sell clock better horn digital prevent image toward sort first voyage detail inner regular improve'

  if (config.newWallet) {
    seed = await BIP39Seed.generate()
  } else {
    seed = await BIP39Seed.generate(config.phrase || phrase)
  }

  let store = config.store || _store
  if (config.tmpStore) {
    store = newStore(config.tmpStore)
  }
  const km = new KeyManager({
    seed
  })
  await km.init()
  const btcPay = new BitcoinPay({
    asset_name: 'btc',
    provider: await electrumConnect({ store }),
    key_manager: km,
    store,
    network: 'regtest'
  })

  await btcPay.initialize({})
  return btcPay
}

async function pause(ms) {
  console.log('Pausing.... ' + ms + 'ms')
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

function promiseSteps(arr) {
  const pass = {}
  for (const state of arr) {
    pass[state] = {}
    pass[state].promise = new Promise((resolve, reject) => {
      pass[state].resolve = resolve
      pass[state].reject = reject
    })
  }
  return pass
}

async function rmDataDir() {
  fs.rmSync(_datadir, { recursive: true, force: true })
}

module.exports = {
  rmDataDir,
  BitcoinPay,
  WalletStore: WalletStoreHyperbee,
  KeyManager,
  BIP39Seed,
  Electrum,
  electrumConnect,
  bitcoinCoreConnect,
  activeWallet,
  regtestNode,
  pause,
  promiseSteps,
  BitcoinCurrency: BitcoinCurr
}
