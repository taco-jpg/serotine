const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript')
const {test}=require('node:test')
const groupDatabase=require('./support/group-admission-fixture.cjs')
const root=path.join(__dirname,'..')
function harness(t){
  const fixture=groupDatabase();t.after(()=>fixture.sqlite.close())
  const state=fixture.state;state.now=Date.now();const cache=new Map()
  class Clock extends Date {static now(){return state.now}}
  function load(filename){
    if(!path.extname(filename))filename+='.ts'
    if(cache.has(filename))return cache.get(filename).exports
    const module={exports:{}};cache.set(filename,module)
    const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
    const requireSource=name=>name==='server-only'?{}:name==='@opennextjs/cloudflare'?{getCloudflareContext:async()=>({env:fixture.env})}:name==='./db'?{getDB:async()=>fixture.db}:name.startsWith('@/')?load(path.join(root,name.slice(2))):name.startsWith('.')?load(path.resolve(path.dirname(filename),name)):require(name)
    new Function('require','module','exports','Date',source)(requireSource,module,module.exports,Clock);return module.exports
  }
  const protocol=load(path.join(root,'lib/group-admission.ts')),server=load(path.join(root,'lib/group-admission-server.ts')),auth=load(path.join(root,'lib/request-auth.ts')),cryptoModule=load(path.join(root,'lib/crypto.ts'))
  async function identity(){const pair=await cryptoModule.generateEncryptionKeyPair();return {version:2,privateKey:await cryptoModule.exportKey(pair.privateKey),publicKey:await cryptoModule.exportPublicKeyToHex(pair.publicKey)}}
  async function request(who,action,data){return server.handleGroupAdmission(action,data,await auth.createRequestProof('group:'+action,data,who.privateKey,who.publicKey))}
  async function setup(){const [owner,guest,other]=await Promise.all([identity(),identity(),identity()]);const data={groupId:'group:'+crypto.randomUUID(),admin:owner.publicKey};await request(owner,'create',data);const invitation=await protocol.signGroupInvitation({id:crypto.randomUUID(),...data,invitee:guest.publicKey,createdAt:state.now,expiresAt:state.now+60000},owner);await request(owner,'invite',{...data,invitation});return {owner,guest,other,data,invitation}}
  return {...fixture,state,protocol,server,auth,identity,request,setup,load}
}

test('only the invited identity can accept; administrator cannot manufacture acceptance or another invitation',async t=>{
 const h=harness(t),{owner,guest,other,data,invitation}=await h.setup()
 const acceptance=await h.protocol.signGroupAcceptance(invitation,guest)
 await assert.rejects(h.request(owner,'accept',{...data,acceptance}),/Invalid signed/)
 await assert.rejects(h.request(other,'accept',{...data,acceptance}),/Invalid signed/)
 await assert.rejects(h.request(other,'revoke',{...data,invitationId:invitation.id}),/administrator/)
 const accepted=await h.request(guest,'accept',{...data,acceptance});assert.equal(accepted.invitations[0].status,'accepted')
 assert.equal((await h.request(guest,'accept',{...data,acceptance})).invitations.length,1)
 await assert.rejects(h.request(owner,'revoke',{...data,invitationId:invitation.id}),/already resolved/)
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM GroupInvitationStatus').get().count,1)
})

test('expiry, decline and revoke remain terminal for an invitation after duplicate registration',async t=>{
 const h=harness(t)
 for(const resolution of ['expiry','decline','revoke']){
  const {owner,guest,data,invitation}=await h.setup(),acceptance=await h.protocol.signGroupAcceptance(invitation,guest)
  if(resolution==='expiry')h.state.now+=60001
  else await h.request(resolution==='decline'?guest:owner,resolution,{...data,invitationId:invitation.id})
  await assert.rejects(h.request(guest,'accept',{...data,acceptance}),/expired|declined|revoked/)
  if(resolution!=='expiry'){await h.request(owner,'invite',{...data,invitation});await assert.rejects(h.request(guest,'accept',{...data,acceptance}),/declined|revoked/)}
 }
})

test('acceptance racing dissolution cannot reopen membership or recreate the terminal group',async t=>{
 const h=harness(t),{owner,guest,data,invitation}=await h.setup(),acceptance=await h.protocol.signGroupAcceptance(invitation,guest)
 await Promise.allSettled([h.request(guest,'accept',{...data,acceptance}),h.request(owner,'dissolve',data)])
 assert.equal((await h.request(guest,'status',data)).terminal,true)
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM GroupInvitationStatus').get().count,0)
 await assert.rejects(h.request(guest,'accept',{...data,acceptance}),/no longer exists/)
 await assert.rejects(h.request(owner,'create',data),/no longer exists/)
 const fresh=await h.protocol.signGroupInvitation({...invitation,id:crypto.randomUUID()},owner)
 await assert.rejects(h.request(owner,'invite',{...data,invitation:fresh}),/no longer exists/)
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM GroupInvitationStatus').get().count,0)
})

test('proofs bind exact group actions and payloads; replay and retired identities are denied',async t=>{
 const h=harness(t),{owner,guest,data}=await h.setup()
 const proof=await h.auth.createRequestProof('group:status',data,guest.privateKey,guest.publicKey)
 await h.server.handleGroupAdmission('status',data,proof)
 await assert.rejects(h.server.handleGroupAdmission('status',data,proof),/already used/)
 await assert.rejects(h.server.handleGroupAdmission('dissolve',data,proof),/signature/)
 const changed={...data,groupId:'group:'+crypto.randomUUID()}
 await assert.rejects(h.server.handleGroupAdmission('status',changed,proof),/signature/)
 h.sqlite.prepare('INSERT INTO RetiredIdentity VALUES(?,?)').run(owner.publicKey,h.state.now)
 await assert.rejects(h.request(owner,'dissolve',data),/retired/)
 const columns=h.sqlite.prepare('PRAGMA table_info(GroupAuthority)').all().map(row=>row.name)
 assert.deepEqual(columns,['groupId','admin','terminalAt','createdAt'])
})

test('dissolution purges scoped ciphertext; failed object deletion leaves terminal authority and retries without revival',async t=>{
 const h=harness(t),{owner,guest,data,invitation}=await h.setup()
 const retention=h.load(path.join(root,'lib/retention-server.ts')),schema=h.load(path.join(root,'lib/event-relay-schema.ts'))
 const payloads=h.load(path.join(root,'lib/relay-payloads.ts'))
 await schema.ensureEventRelaySchema(h.db)
 const scopeId=await retention.registerRetention(h.db,{kind:'group',founder:owner.publicKey,key:data.groupId.slice(6),timestamp:h.state.now},owner.publicKey)
 h.env.SEROTINE_STORAGE_VERSION='2'
 const encryptedData=await payloads.storeRelayPayload('synthetic encrypted group payload',{id:scopeId,timestamp:h.state.now,db:h.db})
 h.sqlite.prepare('INSERT INTO RelayEvent(id,senderPubKey,recipientPubKey,encryptedData,payloadBytes,createdAt,expiresAt,retentionScope,retentionTimestamp) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(crypto.randomUUID(),owner.publicKey,guest.publicKey,encryptedData,33,h.state.now,h.state.now+86400_000,scopeId,h.state.now)
 h.state.failDelete=true
 await assert.rejects(h.request(owner,'dissolve',data),/dissolved.*cleanup is pending/)
 assert.equal((await h.request(guest,'status',data)).terminal,true)
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n,0)
 assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM GroupInvitationStatus').get().n,0)
 assert.equal(h.objects.size,1,'failed deletion remains queued for retry')
 await assert.rejects(retention.assertRetentionOpen(h.db,scopeId,h.state.now+1),/retention.*ended/)
 await assert.rejects(h.request(owner,'create',data),/no longer exists/)
 await assert.rejects(h.request(guest,'accept',{...data,acceptance:await h.protocol.signGroupAcceptance(invitation,guest)}),/no longer exists/)
 h.state.failDelete=false
 assert.equal((await h.request(owner,'dissolve',data)).terminal,true)
 assert.equal(h.objects.size,0)
 assert.equal((await h.request(owner,'dissolve',data)).terminal,true)
})
