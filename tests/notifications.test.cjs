const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/message-notifications.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const compiled = { exports: {} }
new Function('module', 'exports', source)(compiled, compiled.exports)
const { shouldNotify } = compiled.exports
const owner = 'alice'
const message = { senderPubKey: 'bob' }
const conversation = { blocked: false, request: false, notificationMode: 'all' }

test('notification filters protect muted chats, requests, blocked senders and self-chat', () => {
  assert.equal(shouldNotify(message, conversation, owner), true)
  assert.equal(shouldNotify({ senderPubKey: owner }, conversation, owner), false)
  for (const override of [{ blocked: true }, { request: true }, { notificationMode: 'muted' }]) {
    assert.equal(shouldNotify(message, { ...conversation, ...override }, owner), false)
  }
})

test('mentions-only notifications require an explicit mention of this identity', () => {
  const mentions = { ...conversation, notificationMode: 'mentions' }
  assert.equal(shouldNotify(message, mentions, owner), false)
  assert.equal(shouldNotify({ ...message, mentions: ['someone-else'] }, mentions, owner), false)
  assert.equal(shouldNotify({ ...message, mentions: [owner] }, mentions, owner), true)
})
