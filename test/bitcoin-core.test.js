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
const test = require('brittle')
const { WalletStoreMemory } = require('lib-wallet-store')
const { newBitcoinCore } = require('./test-helpers.js')

test('Bitcoin Core', async function (t) {
  const methods = [
    {
      method: 'getblockchaininfo',
      params: [],
      expected: [{
        "chain": "regtest"
      }]
    }
  ]

  t.test('Bitcoin Core methods', async function (t) {
    const bc = await newBitcoinCore({
      store: new WalletStoreMemory({})
    })
    const res = await bc.ping()
    t.ok(res === 'pong', 'ping')

    await Promise.all(methods.map(async function (m) {
      console.log("Test:", m.method)
      const res = await bc.rpc(m.method, m.params)
      console.log(res)
      t.ok(res.chain === m.expected[0].chain, m.method)
    }))
    await bc.close()
  })
})
