/* eslint-disable no-console */
/* global SerotineTest, engine */
const fs=require('fs'),assert=require('assert/strict'),{spawn}=require('child_process');
const root=require('path').resolve(__dirname,'..');
const {chromium}=require('playwright');
const esbuild=require(root+'/node_modules/esbuild');
const origin='http://localhost:3100';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function makeIdentity(){const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits','deriveKey']);return {version:2,publicKey:Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex'),privateKey:await crypto.subtle.exportKey('jwk',pair.privateKey)}}
(async()=>{
 const bundle=(await esbuild.build({stdin:{contents:'export * from "./lib/messaging";export * from "./lib/messaging-store";export * from "./lib/identity";export * from "./lib/full-backup";export * from "./lib/attachments";',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',globalName:'SerotineTest',tsconfig:root+'/tsconfig.json'})).outputFiles[0].text;
 const log=fs.openSync('/tmp/serotine-e2e-server.log','w');
 const server=spawn(process.execPath,[root+'/node_modules/next/dist/bin/next','dev','--port','3100','--hostname','127.0.0.1'],{cwd:root,stdio:['ignore',log,log]});let browser;
 try{
  for(let i=0;i<60;i++){try{const r=await fetch(origin);if(r.ok)break}catch { /* Wait for the local server to start. */ } await sleep(500)}
  browser=await chromium.launch({executablePath:process.env.SEROTINE_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],headless:true});
  const errors=[];const identities=await Promise.all([makeIdentity(),makeIdentity(),makeIdentity()]);const pages=[];
  async function makePage(identity){const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(r.url().includes('/api/relay')&&r.status()>=400) console.log('RELAY ERROR',r.status(),await r.text());else if(r.url().includes('/api/relay')) {const j=await r.json();if(j.success===false)console.log('RELAY FAILURE',j.error)}});await page.goto(origin);await page.addScriptTag({content:bundle});if(identity)await page.evaluate(id=>localStorage.setItem('serotine_identity_v2',JSON.stringify(id)),identity);pages.push(page);return page}
  async function start(page){await page.evaluate(async()=>{window.engine=new SerotineTest.MessagingEngine(await SerotineTest.loadIdentity());await engine.start()})}
  const [a,b,c]=await Promise.all(identities.map(makePage));await Promise.all([a,b,c].map(start));
  async function settle(predicate,label,timeout=35000){const end=Date.now()+timeout;while(Date.now()<end){await Promise.race([Promise.all(pages.map(p=>p.evaluate(async()=>{if(window.engine)await engine.sync()}))),sleep(20000).then(()=>{throw Error('sync timeout at '+label)})]);if(await predicate())return;await sleep(250)}const status=await Promise.all(pages.map(p=>p.evaluate(()=>({error:window.engine?.error,status:window.engine?.status,records:window.engine?.records?.length}))));throw Error(label+' '+JSON.stringify(status))}
  const aid=identities[0].publicKey,bid=identities[1].publicKey,cid=identities[2].publicKey;
  const direct=await a.evaluate(async peer=>engine.sendText(peer,'Hello from Alice'),bid);
  await settle(()=>b.evaluate(id=>engine.model.messages.some(m=>m.id===id),direct),'direct receive');
  assert.equal(await b.evaluate(peer=>engine.model.requests.some(r=>r.id===peer),aid),true);
  await b.evaluate(async peer=>{await engine.acceptRequest(peer);await engine.sendText(peer,'Reply from Bob')},aid);
  await settle(()=>a.evaluate(()=>engine.model.messages.some(m=>m.content==='Reply from Bob')),'reply receive');
  console.log('PASS direct encryption transport, global inbox and message requests');
  await a.evaluate(async({peer,id})=>{await engine.editMessage(peer,id,'Edited hello');await engine.pinMessage(peer,id,true)}, {peer:bid,id:direct});
  await settle(()=>b.evaluate(id=>engine.model.messages.some(m=>m.id===id&&m.content==='Edited hello'&&m.pinned),direct),'edit/pin');
  const poll=await a.evaluate(async peer=>engine.createPoll(peer,'Which day?',['Wednesday','Friday']),bid);
  await settle(()=>b.evaluate(id=>engine.model.messages.some(m=>m.id===id),poll),'poll receive');
  await b.evaluate(async({peer,id})=>engine.vote(peer,id,1),{peer:aid,id:poll});
  await settle(()=>a.evaluate(({id,peer})=>engine.model.messages.find(m=>m.id===id)?.poll?.votes[peer]===1,{id:poll,peer:bid}),'poll vote');
  await b.evaluate(peer=>engine.markRead(peer),aid);
  await settle(()=>a.evaluate(id=>engine.model.messages.find(m=>m.id===id)?.delivery==='read',direct),'read receipt');
  console.log('PASS edits, pins, polls and read receipts');
  const group=await a.evaluate(async peers=>engine.createGroup('Integration group',peers),[bid,cid]);
  await settle(()=>b.evaluate(id=>engine.model.groups.some(g=>g.id===id),group),'group invite');
  await Promise.all([b,c].map(p=>p.evaluate(id=>engine.acceptRequest(id),group)));
  await a.evaluate(id=>engine.sendText(id,'Group hello'),group);
  await settle(()=>c.evaluate(()=>engine.model.messages.some(m=>m.content==='Group hello')),'group receive');
  await b.evaluate(id=>engine.leaveGroup(id),group);
  await settle(()=>a.evaluate(({id,peer})=>!engine.model.conversations.find(x=>x.id===id)?.members.includes(peer),{id:group,peer:bid}),'member leave');
  await settle(()=>a.evaluate(({id,peer})=>!engine.model.groups.find(x=>x.id===id)?.members.includes(peer),{id:group,peer:bid}),'membership epoch advance');
  await a.evaluate(id=>engine.sendText(id,'After Bob left'),group);
  await settle(()=>c.evaluate(()=>engine.model.messages.some(m=>m.content==='After Bob left')),'remaining member receive');
  assert.equal(await b.evaluate(()=>engine.model.messages.some(m=>m.content==='After Bob left')),false);
  console.log('PASS group fanout and member departure confidentiality');
  const attachment=await a.evaluate(async peer=>SerotineTest.sendAttachment(engine.sendEvent,peer,new File([new Uint8Array(75000).fill(37)],'sample.bin',{type:'application/octet-stream'})),bid);
  await settle(()=>b.evaluate(id=>{const m=engine.model.messages.find(m=>m.id===id);return !!m&&engine.getAttachmentChunks(m.conversationId,id).length===m.attachment.chunks},attachment),'file receive',60000);
  assert.equal(await b.evaluate(async id=>{const m=engine.model.messages.find(m=>m.id===id);const blob=await SerotineTest.assembleAttachment(m.attachment,engine.getAttachmentChunks(m.conversationId,id));return blob.size},attachment),75000);
  await a.evaluate(peer=>engine.sendText(peer,'Self message'),aid);
  await settle(()=>a.evaluate(()=>engine.model.messages.some(m=>m.content==='Self message')),'self chat');
  console.log('PASS chunked file delivery/integrity and ordinary self-chat');
  const backup=await a.evaluate(async()=>SerotineTest.exportFullBackup(engine.identity,'integration password 123'));
  const a2=await makePage();await a2.evaluate(async text=>SerotineTest.restoreBackup(text,'integration password 123'),backup);await start(a2);
  await b.evaluate(peer=>engine.sendText(peer,'Both Alice devices'),aid);
  await settle(async()=>await a.evaluate(()=>engine.model.messages.some(m=>m.content==='Both Alice devices'))&&await a2.evaluate(()=>engine.model.messages.some(m=>m.content==='Both Alice devices')),'linked incoming');
  await a2.evaluate(peer=>engine.sendText(peer,'From linked Alice'),bid);
  await settle(async()=>await a.evaluate(()=>engine.model.messages.some(m=>m.content==='From linked Alice'))&&await b.evaluate(()=>engine.model.messages.some(m=>m.content==='From linked Alice')),'linked outgoing');
  console.log('PASS encrypted full backup and two-device incoming/outgoing synchronization');
  await a.goto(origin+'/chat/'+aid);await a.getByRole('textbox',{name:'Message',exact:true}).waitFor({state:'visible',timeout:30000});await a.getByRole('textbox',{name:'Message',exact:true}).fill('Typed into self chat');await a.getByRole('button',{name:'Send message',exact:true}).click();await a.getByText('Typed into self chat',{exact:true}).last().waitFor({state:'visible',timeout:20000});
  await a.getByRole('button',{name:'Voice',exact:true}).click();await a.getByRole('button',{name:'Stop & preview',exact:true}).waitFor();await sleep(1200);await a.getByRole('button',{name:'Stop & preview',exact:true}).click();await a.getByRole('button',{name:'Send voice message',exact:true}).click();await a.locator('audio').first().waitFor({state:'visible'});console.log('PASS microphone permission, recording preview and voice-message send');await a.screenshot({path:'/tmp/serotine-desktop.png'});await a.setViewportSize({width:390,height:844});await a.screenshot({path:'/tmp/serotine-mobile.png'});
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile must not overflow');
  console.log('PASS rendered self-chat composer on desktop and mobile');
  assert.deepEqual(errors,[],'browser page errors');
  console.log('ALL BROWSER INTEGRATION CHECKS PASSED');
 }finally{await browser?.close();server.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
