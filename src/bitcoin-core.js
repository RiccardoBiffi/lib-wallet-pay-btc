// Copyright 2024 Tether Operations Limited
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict'
const { EventEmitter } = require('events')
const Bitcoin = require('./currency')
const zmq = require("zeromq");


// TODO: handle unsupported Bitcoin Core RPC methods

function getBlockReward(height) {
  const initialReward = Bitcoin.BN(50).times(100000000) // 50 BTC in satoshis
  const halvingInterval = 210000
  const halvings = Math.floor(height / halvingInterval)
  const reward = initialReward.dividedBy(Bitcoin.BN(2).pow(halvings))
  return new Bitcoin(reward, 'base')
}

/**
* @class RequestCache
* @desc Cache requests to Bitcoin Core server
* @param {Object} config - configuration
* @param {Object} config.store - store to cache requests
* @param {Number} config.cache_timeout - cache timeout
* @param {Number} config.max_cache_size - max cache size
* @param {Number} config.cache_interval - cache interval
* @param {Number} config.cache_size - cache size
**/
class RequestCache {
  constructor(config) {
    this.store = config.store
    this._cache_expiry = config.cache_timeout || 300000 // 5min
    this._max_cache_size = config.max_cache_size || 10000
    this._cache_size = 0
    this._closing = false
  }

  async clear() {
    return this.store.clear()
  }

  async stop() {
    clearInterval(this._timer)
    return this.store.close()
  }

  _startCacheTimer() {
    this._timer = setInterval(() => {
      this.store.entries(async (k, [value, exp]) => {
        if (Date.now() >= exp) return await this.store.delete(k)
      })
    }, this._cache_interval)
  }

  async _getCacheIndex() {
    return await (this.store.get('cache_index')) || []
  }

  async _removeOldest() {
    const index = await this._getCacheIndex()
    const key = index.shift()
    await this.store.delete(key)
    await this.store.put('cache_index', index)
  }

  async set(key, value) {
    let data
    if (this._cache_size >= this._max_session_size) {
      await this._removeOldest()
    }
    if (!value.expiry) {
      data = [value, Date.now() + this._cache_expiry]
    } else {
      data = [value, value.expiry]
    }
    const index = await this._getCacheIndex()
    index.push(key)
    await this.store.put('cache_index', index)
    this.size = index.length
    return this.store.put(key, data)
  }

  async get(key) {
    const data = await this.store.get(key)
    return data ? data[0] : null
  }

  get size() {
    return this._cache_size
  }

  set size(val) {
    return null
  }
}

class BitcoinCore extends EventEmitter {
  constructor(config = {}) {
    super()
    this._host = config.host || '127.0.0.1'
    this._port = config.port || 18443
    this._user = config.user || 'user'
    this._pass = config.pass || 'password'
    this._auth = Buffer.from(`${this._user}:${this._pass}`).toString('base64');
    this._wallet = config.wallet || 'main.dat'

    this._zmqPort = config.zmqPort || 28334
    this._socket = null
    this._is_socket_open = false
    this._is_blockhash_subscribed = false
    this._is_raw_tx_subscribed = false
    this._internal_event = new EventEmitter();
    this._address_subscriptions = []

    this._net = config.net || require('net')
    this.clientState = 0
    this.requests = new Map()
    this.cache = new RequestCache({ store: config.store.newInstance({ name: 'bitcoin-core-cache' }) })
    this.block_height = 0
    this._max_cache_size = 10
    this._reconnect_count = 0
    this._max_attempt = 10
    this._reconnect_interval = 2000
    this._closed = false

  }

  static OutTypes = {
    0: 'non-standard',
    1: 'standard'
  }

  /**
  * Connect to Bitcoin Core
  * @param {Object} opts - options
  * @param {Boolean} opts.reconnect - reconnect if connection is lost.
  **/
  connect(opts = {}) {
    if (opts.reconnect) this._reconnect_count = 0
    return new Promise((resolve, reject) => {
      this._client = this._net.connect(this._port, this._host, () => {
        console.log('Connected to Bitcoin Core');
        this.clientState = 1
        this._reconnect_count = 0
        resolve()
      })
      this._client.on('data', (data) => {
        const response = data.toString().split('\n')
        response.forEach((data) => {
          if (!data) return
          this._handleResponse(data)
        })
      })
      this._client.once('close', () => {
        this.clientState = 0
        this._reconn(resolve, reject, _err)
      })
      let _err
      this._client.once('error', (err) => {
        _err = err
        this.clientState = 0
      })
    })
  }

  async _reconn(resolve, reject, err = {}) {
    const errMsg = err.message || err.errors?.map(e => e.message).join(' ')
    if (this._reconnect_count >= this._max_attempt)
      return reject(new Error('gave up connecting to Bitcoin Core ' + errMsg))
    setTimeout(async () => {
      if (this._reconnect_count >= this._max_attempt)
        return reject(new Error('gave up connecting to Bitcoin Core ' + errMsg))
      this._reconnect_count++
      try {
        await this.connect()
      } catch (err) {
        if (this._reconnect_count >= this._max_attempt) return reject(err)
        await this._reconn(resolve, reject)
        return
      }
      resolve()
    }, this._reconnect_interval)
  }

  _rpcPayload(method, params, id) {
    return JSON.stringify({
      jsonrpc: '1.0',
      id: id,
      method: method,
      params: params
    })
  }

  _httpRequest(payload) {
    return (
      `POST / HTTP/1.1\r\n` +
      `Host: ${this._host}\r\n` +
      `Authorization: Basic ${this._auth}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      `\r\n` +
      `${payload}`
    )
  }

  _makeRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error('client closed'))
      if (this.clientState !== 1) {
        return reject(new Error('client not connected'))
      }
      const id = Date.now() + '-' + parseInt(Math.random() * 100000000)
      const payload = this._rpcPayload(method, params, id)
      const request = this._httpRequest(payload)
      this.requests.set(id, [resolve, reject, method])
      this._client.write(request)
    })
  }

  _handleResponse(data) {
    let resp
    try {
      resp = JSON.parse(data.toString())
    } catch (err) {
      this.emit('request-error', err)
      return
    }

    if (resp?.method?.includes('.subscribe')) {
      this.emit(resp.method, resp.params.pop())
      this.requests.delete(resp?.id)
      return
    }

    const _resp = this.requests.get(resp.id)
    const [resolve, reject, method] = _resp || []

    if (resp.error) {
      if (reject) {
        reject(new Error(`RPC Error: ${JSON.stringify(resp.error)} - ${method}`))
      }
      return this.requests.delete(resp.id)
    }

    if (!resolve)
      return this.emit('request-error', `no handler for response id: ${resp.id} - ${JSON.stringify(resp)}`)

    const isNull = resp.result === null

    resolve(isNull ? null : (resp.result || resp.error))
    this.requests.delete(resp.id)
  }

  //todo change address to scripthash
  async getAddressHistory(opts, address) {
    const receivedTx = await this._makeRequest('listreceivedbyaddress', [0, false, true, address])
    const history = receivedTx[0].txids
    const txData = []
    for (const i in history) {
      const td = await this.getTransaction(history[i], opts)
      txData.push(td)
    }
    return txData
  }

  _getTransaction(txid) {
    return this._makeRequest('gettransaction', [txid, true, true])
  }

  //todo change address to scripthash
  async getBalance(address) {
    const confirmed = await this._makeRequest('getreceivedbyaddress', [address, 1])
    const unconfirmed = await this._makeRequest('getreceivedbyaddress', [address, 0])
    return {
      confirmed: confirmed * 10 ** 8 || 0,
      unconfirmed: (unconfirmed - confirmed) * 10 ** 8 || 0
    }
  }

  async broadcastTransaction(tx) {
    return this._makeRequest('sendrawtransaction', [tx])
  }

  _processTxVout(vout, tx) {
    return {
      address: this._getTxAddress(vout.scriptPubKey),
      value: new Bitcoin(vout.value, 'main'),
      witness_hex: vout?.scriptPubKey.hex,
      index: vout.n,
      txid: tx.txid,
      height: tx.height
    }
  }

  _procTxHeight(tx) {
    if (!tx.confirmations) {
      tx.height = 0
    } else {
      tx.height = this.block_height - (tx.confirmations - 1)
    }
    return tx
  }

  async _txGet(txid, opts) {
    const cache = this.cache

    if (opts.cache === false) {
      let data = await this._getTransaction(txid)
      data = this._procTxHeight(data)
      await cache.set(txid, data)
      return data
    }
    const cacheValue = await cache.get(txid)
    if (cacheValue && cacheValue.height !== 0) {
      return cacheValue
    }
    let data = await this._getTransaction(txid)
    data = this._procTxHeight(data)
    await cache.set(txid, data)
    return data
  }

  /**
  * @description get transaction details. Store tx in cache.
  */
  async getTransaction(txid, opts = {}) {
    const data = {
      txid,
      out: [],
      in: [],
      unconfirmed_inputs: [],
      std_out: [],
      std_in: []
    }

    const tx = await this._txGet(txid, opts)
    data.height = tx.height

    let totalOut = new Bitcoin(0, 'main')
    data.out = tx.decoded.vout.map((vout) => {
      const newvout = this._processTxVout(vout, tx)
      if (!newvout || !newvout.address) {
        data.std_out.push(false)
        return null
      }
      data.std_out.push(true)
      totalOut = totalOut.add(newvout.value)
      newvout.tx_height = tx.height
      return newvout
    }).filter(Boolean)

    let totalIn = new Bitcoin(0, 'main')
    data.in = await Promise.all(tx.decoded.vin.map(async (vin) => {
      if (vin.coinbase) {
        const value = getBlockReward(tx.height - 1)
        data.std_in.push(false)
        return {
          prev_txid: `${vin.coinbase}00000000`,
          prev_index: 0,
          prev_tx_height: tx.height - 1,
          txid: vin.coinbase,
          address: vin.coinbase,
          out_type: 0,
          value
        }
      }
      data.std_in.push(false)
      const txDetail = await this._txGet(vin.txid, opts)
      const newvin = this._processTxVout(txDetail.decoded.vout[vin.vout], tx)
      newvin.prev_txid = vin.txid
      newvin.prev_index = vin.vout
      newvin.prev_tx_height = txDetail.height
      if (txDetail.height === 0) data.unconfirmed_inputs.push(vin.txid)
      totalIn = totalIn.add(newvin.value)
      return newvin
    }))

    if (totalIn.toNumber() === 0) {
      data.fee = totalIn
    } else {
      data.fee = totalIn.minus(totalOut)
    }

    return data
  }

  _getTxAddress(scriptPubKey) {
    if (scriptPubKey.address) return scriptPubKey.address
    // if (scriptPubKey.addresses) return scriptPubKey.addresses
    // Non standard outputs like OP_RETURN, multi-sig
    return null
  }

  async subscribeToBlocks() {
    if (!this._is_socket_open)
      this._startSocket()

    this._socket.subscribe("hashblock")
    this._is_blockhash_subscribed = true;
    this._internal_event.on("hashblock", this._handleBlockEvent)
  }

  _handleBlockEvent = async (message) => {
    const messageHex = message.toString("hex");
    const rawBlock = await this.rpc('getblock', [messageHex, 0])
    const block = await this.rpc('getblock', [messageHex, 1])
    this.emit('new-block', { height: block.height, hex: rawBlock })
  }

  async unsubscribeFromBlocks() {
    this._is_blockhash_subscribed = false
    this._internal_event.off("hashblock", this._handleBlockEvent)
    return true
  }

  async close() {
    this._closed = true
    await this._stopClient()
    await this.cache.stop()
  }

  _stopClient() {
    return new Promise((resolve) => {
      this.removeAllListeners()
      this.clientState = 0
      this._reconnect_count = this._max_attempt
      this._client.on('end', () => resolve())
      this._client.end()
    })
  }

  rpc(method, params) {
    return this._makeRequest(method, params)
  }

  async ping(opts) {
    const res = await this._makeRequest('ping', [])
    if (!res) return 'pong'
    throw new Error('ping failed')
  }

  _startSocket() {
    this._socket = new zmq.Subscriber()
    this._socket.connect(`tcp://${this._host}:${this._zmqPort}`);
    this._is_socket_open = true;
    (async () => {
      try {
        //todo find a way to stop the loop without waiting for a new message
        for await (const [topic, message] of this._socket) {
          if (!this._isSocketUsed()) break
          const topicStr = topic.toString();
          const messageHex = message.toString("hex");

          this._internal_event.emit(topicStr, messageHex)
        }
      }
      catch (err) {
        console.error("Error in listener loop:", err);
      } finally {
        this._socket.close()
        this._is_socket_open = false
      }
    })();
  }

  _isSocketUsed() {
    return this._is_blockhash_subscribed || this._is_raw_tx_subscribed
  }

  //todo change input to scripthash
  async subscribeToAddress(address) {
    if (!this._is_socket_open)
      this._startSocket()

    this._address_subscriptions.push(address)
    if (this._address_subscriptions.length > 1) {
      return
    }

    this._socket.subscribe("rawtx")
    this._is_raw_tx_subscribed = true
    this._internal_event.on("rawtx", this._handleTxEvent)
  }

  _handleTxEvent = async (message) => {
    const messageHex = message.toString("hex")
    const tx = await this.rpc('decoderawtransaction', [messageHex])
    const addressUtxo = tx.vout.filter(async (out) => this._address_subscriptions.includes(out.scriptPubKey.address))
    if (addressUtxo.length) {
      //todo calculate and emit transaction status
      this.emit('new-tx', tx)
    }
  }

  //todo change input to scripthash
  async unsubscribeFromAddress(address) {
    this._address_subscriptions = this._address_subscriptions.filter(a => a !== address)
    if (this._address_subscriptions.length === 0) {
      this._is_raw_tx_subscribed = false
      this._internal_event.off("rawtx", this._handleTxEvent)
    }
    return true
  }

  isConnected() {
    return this.clientState === 1
  }
}

module.exports = BitcoinCore