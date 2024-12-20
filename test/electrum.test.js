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
const { electrumConnect, regtestNode } = require('./test-helpers.js')

let electrumProvider;
let bc;

hook('Setup', async t => {
  bc = await regtestNode()
  await bc.init()
  const balance = (await bc.getBalance()).result
  if (balance <= 1) {
    await bc.mine({ blocks: 101 })
  }

  electrumProvider = await electrumConnect({
    store: new WalletStoreMemory({})
  })
})


test('Electrum connected successfully', async t => {
  t.plan(1)
  t.ok(electrumProvider.isConnected(), 'Client should be connected')
})


test('Electrum subscribes and unsubscribes to blocks', async t => {
  await electrumProvider.subscribeToBlocks()

  await new Promise((resolve, reject) => {
    electrumProvider.once('new-block', async (height) => {
      try {
        t.plan(3)
        t.pass('Should receive new block notification')
        const info = await bc.getBlockchainInfo()
        t.is(height.height, info.result.blocks, 'Should receive the correct block height')
        const result = await electrumProvider.unsubscribeFromBlocks()
        t.ok(result, 'Should unsubscribe from blocks notifications')
        resolve();
      } catch (err) {
        reject(err);
      }
    })

    bc.mine({ blocks: 1 })
  })
})


test('Electrum subscribes and unsubscribes to address', async t => {
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)

  await electrumProvider.subscribeToAddress(scriptHash)
  bc.sendToAddress({ address: to.result, amount: 0.1 })

  await new Promise((resolve, reject) => {
    electrumProvider.once('new-tx', async (data) => {
      try {
        t.plan(2)
        t.pass('Should receive new transaction notification')
        const result = await electrumProvider.unsubscribeFromAddress(scriptHash)
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

  const electrumTx = await electrumProvider.getTransaction(tx.result)

  t.plan(4)
  t.is(electrumTx.txid, tx.result, 'Should get single transaction')
  const utxo = electrumTx.out.find(out => out.address === to.result)
  t.is(utxo.address, to.result, 'Should get to address')
  t.is(utxo.value.amount, amount.toString(), 'Should get amount')
  t.exception(electrumProvider.getTransaction('invalid-txid'), 'Should throw error for invalid txid')
})


test('Electrum getBalance returns confirmed and unconfirmed balances', async t => {
  const amount = 0.1
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)
  await electrumProvider.subscribeToAddress(scriptHash)
  await bc.sendToAddress({ address: to.result, amount: amount })

  await new Promise((resolve, reject) => {
    electrumProvider.once('new-tx', async (data) => {
      try {
        const balance = await electrumProvider.getBalance(scriptHash)

        t.plan(3)
        t.is(balance.confirmed, 0, 'Confirmed balance should be 0')
        t.is(balance.unconfirmed, amount * 10 ** 8, `Unconfirmed balance should be ${amount}`)
        t.exception(electrumProvider.getBalance('invalid-scripthash'), 'Should throw error for invalid scripthash')

        resolve();
      } catch (err) {
        reject(err);
      }
      finally {
        await electrumProvider.unsubscribeFromAddress(scriptHash)
      }
    })
  })
})


test('Electrum getAddressHistory returns transactions', async t => {
  const amount = 0.1
  const to = await bc.getNewAddress()
  const scriptHash = bc.addressToScriptHash(to.result)
  await electrumProvider.subscribeToAddress(scriptHash)
  const tx1 = await bc.sendToAddress({ address: to.result, amount: amount })
  const tx2 = await bc.sendToAddress({ address: to.result, amount: amount })

  await new Promise((resolve, reject) => {
    electrumProvider.once('new-tx', async (data) => {
      try {
        const electrumTxs = await electrumProvider.getAddressHistory({}, scriptHash)
        const electrumTxIds = electrumTxs.map(tx => tx.txid)

        t.plan(7)
        t.ok(electrumTxIds.includes(tx1.result), 'First transaction should be included')
        const utxo1 = electrumTxs.find(tx => tx.txid === tx1.result)
          .out.find(out => out.address === to.result)
        t.is(utxo1.address, to.result, 'Should get to address of first transaction')
        t.is(utxo1.value.amount, amount.toString(), 'Should get amount of first transaction')
        t.ok(electrumTxIds.includes(tx2.result), 'Second transaction should be included')
        const utxo2 = electrumTxs.find(tx => tx.txid === tx2.result)
          .out.find(out => out.address === to.result)
        t.is(utxo2.address, to.result, 'Should get to address of second transaction')
        t.is(utxo2.value.amount, amount.toString(), 'Should get amount of second transaction')
        t.exception(electrumProvider.getAddressHistory({}, 'invalid-scripthash'), 'Should throw error for invalid scripthash')

        resolve();
      } catch (err) {
        reject(err);
      } finally {
        await electrumProvider.unsubscribeFromAddress(scriptHash)
      }
    })
  })
})


test('Electrum broadcastTransaction successfully', async t => {
  const utxoList = await bc.listUnspent({})
  const { txid, vout, amount } = utxoList.result[0]
  const amountToSend = (amount - 0.01).toFixed(8)
  const to = await bc.getNewAddress()
  const rawTx = await bc.createRawTransaction(
    {
      inputs: [{ txid: txid, vout: vout }],
      outputs: { [to.result]: amountToSend }
    })
  const signedTx = await bc.signRawTransactionWithWallet({ hexstring: rawTx.result })

  const tx = await electrumProvider.broadcastTransaction(signedTx.result.hex)
  const txDetails = await electrumProvider.getTransaction(tx)

  t.plan(5)
  t.ok(tx, 'Signed transaction should be broadcasted')
  t.is(txDetails.txid, tx, 'Should get broadcasted transaction details')
  const utxo = txDetails.out.find(out => out.address === to.result)
  t.is(utxo.address, to.result, 'Should get to address of broadcasted transaction')
  t.is(parseFloat(utxo.value.amount).toFixed(8), amountToSend, 'Should get amount of broadcasted transaction')
  t.exception(electrumProvider.broadcastTransaction('invalid-tx'), 'Should throw error for invalid tx')
})


hook('Teardown', async t => {
  if (electrumProvider.isConnected()) {
    await electrumProvider.close()
  }
})