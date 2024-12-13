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
const { newElectrum } = require('./test-helpers.js')

test('Electrum', async function (t) {
  const methods = [
    {
      method: 'blockchain.transaction.get',
      params: ['6582163ade13c12914035e78dde5682ef23bd369b488a3af38951faae5e8952f', true],
      expected: [
        '6582163ade13c12914035e78dde5682ef23bd369b488a3af38951faae5e8952f',
        'txid'
      ]
    }
  ]

  t.test('Electrum methods', async function (t) {
    const e = await newElectrum({
      store: new WalletStoreMemory({})
    })
    const res = await e.ping()
    t.ok(res === 'pong', 'ping')

    await Promise.all(methods.map(async function (m) {
      const res = await e.rpc(m.method, m.params)
      console.log(res)
      t.ok(res[m.expected[1]] === m.expected[0], m.method)
    }))
    await e.close()
  })
})
