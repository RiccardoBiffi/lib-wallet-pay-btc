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
//
const { test, solo, skip, hook } = require('brittle')
const { WalletStoreMemory } = require('lib-wallet-store')
const { electrumConnect } = require('./test-helpers.js')
const { bitcoin } = require('../../wallet-lib-test-tools')

let electrum;
let bc;

hook('Setup', async t => {
  bc = new bitcoin.BitcoinCore({})
  await bc.init()
  bc.addressToScriptHash
  const balance = (await bc.getBalance()).result
  if (balance <= 1) {
    await bc.mine({ blocks: 101 })
  }

  electrum = await electrumConnect({
    store: new WalletStoreMemory({})
  })
})


test('Electrum connected successfully', async t => {
  t.plan(1)
  t.ok(electrum.isConnected(), 'Client should be connected')

})


test('Electrum subscribes and unsubscribes to blocks', async t => {
  await electrum.subscribeToBlocks()
  bc.mine({ blocks: 1 })

  await new Promise((resolve, reject) => {
    electrum.once('new-block', async (height) => {
      try {
        t.plan(3)
        t.pass('Should receive new block notification')
        const info = await bc.getBlockchainInfo()
        t.is(height.height, info.result.blocks, 'Should receive the correct block height')
        const result = await electrum.unsubscribeFromBlocks()
        t.ok(result, 'Should unsubscribe from blocks notifications')
        resolve();
      } catch (err) {
        reject(err);
      }
    })
  })
})


test('Electrum subscribes and unsubscribes to address', async t => {
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)

  await electrum.subscribeToAddress(scriptHash)
  bc.sendToAddress({ address: to.result, amount: 0.1 })

  await new Promise((resolve, reject) => {
    electrum.once('new-tx', async (data) => {
      try {
        t.plan(2)
        t.pass('Should receive new transaction notification')
        const result = await electrum.unsubscribeFromAddress(scriptHash)
        t.ok(result, 'Should unsubscribe from scripthash notifications')
        resolve();
      } catch (err) {
        reject(err);
      }
    })
  })
})


test('Electrum getTransaction returns transaction details', async t => {
  const amount = 0.1
  const to = await bc.getNewAddress()
  const tx = await bc.sendToAddress({ address: to.result, amount: amount })

  const electrumTx = await electrum.getTransaction(tx.result)

  t.plan(1)
  t.is(electrumTx.txid, tx.result, 'Should get single transaction')
})


test('Electrum getBalance returns confirmed and unconfirmed balances', async t => {
  const amount = 0.1
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)
  await electrum.subscribeToAddress(scriptHash)
  await bc.sendToAddress({ address: to.result, amount: amount })

  await new Promise((resolve, reject) => {
    electrum.once('new-tx', async (data) => {
      try {
        const balance = await electrum.getBalance(scriptHash)

        t.plan(2)
        t.is(balance.confirmed, 0, 'Confirmed balance should be 0')
        t.is(balance.unconfirmed, amount * 10 ** 8, `Unconfirmed balance should be ${amount}`)

        resolve();
      } catch (err) {
        reject(err);
      }
      finally {
        await electrum.unsubscribeFromAddress(scriptHash)
      }
    })
  })
})


test('Electrum getAddressHistory returns transactions', async t => {
  const amount = 0.1
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)
  await electrum.subscribeToAddress(scriptHash)
  const tx1 = await bc.sendToAddress({ address: to.result, amount: amount })
  const tx2 = await bc.sendToAddress({ address: to.result, amount: amount })

  await new Promise((resolve, reject) => {
    electrum.once('new-tx', async (data) => {
      try {
        const electrumTxs = await electrum.getAddressHistory({}, scriptHash)
        const electrumTxIds = electrumTxs.map(tx => tx.txid)

        t.plan(2)
        t.ok(electrumTxIds.includes(tx1.result), 'First transaction should be included')
        t.ok(electrumTxIds.includes(tx2.result), 'Second transaction should be included')
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        await electrum.unsubscribeFromAddress(scriptHash)
      }
    })
  })
})


test('Electrum broadcastTransaction successfully', async t => {
  const utxoList = await bc.listUnspent({})
  const { txid, vout, amount } = utxoList.result[0]
  const to = await bc.getNewAddress()
  const rawTx = await bc.createRawTransaction(
    {
      inputs: [{ txid: txid, vout: vout }],
      outputs: { [to.result]: (amount - 0.01).toFixed(8) }
    })
  const signedTx = await bc.signRawTransactionWithWallet({ hexstring: rawTx.result })

  const tx = await electrum.broadcastTransaction(signedTx.result.hex)
  const txDetails = await electrum.getTransaction(tx)

  t.plan(2)
  t.ok(tx, 'Signed transaction should be broadcasted')
  t.is(txDetails.txid, tx, 'Should get broadcasted transaction details')
})


hook('Teardown', async t => {
  if (electrum.isConnected()) {
    await electrum.close()
  }
})