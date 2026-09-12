/* eslint-disable no-console */
/* global SerotineTest, engine */
const fs=require('fs'),assert=require('assert/strict'),{spawn}=require('child_process');
const root=require('path').resolve(__dirname,'..');
const {chromium}=require('playwright');
const esbuild=require(root+'/node_modules/esbuild');
const port=process.env.SEROTINE_BROWSER_PORT||'3100';
assert.match(port,/^\d+$/,'SEROTINE_BROWSER_PORT must be a port number');
const origin=`http://localhost:${port}`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function makeIdentity(){const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits','deriveKey']);return {version:2,publicKey:Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex'),privateKey:await crypto.subtle.exportKey('jwk',pair.privateKey)}}
(async()=>{
 const bundle=(await esbuild.build({stdin:{contents:'export * from "./lib/messaging";export * from "./lib/messaging-store";export * from "./lib/identity";export * from "./lib/full-backup";export * from "./lib/attachments";export {encryptForPeer,importKey} from "./lib/crypto";export {createRequestProof} from "./lib/request-auth";export {storeEncryptedMessage,getLegacyInbox} from "./lib/relay-client";',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',globalName:'SerotineTest',tsconfig:root+'/tsconfig.json'})).outputFiles[0].text;
 const logPath=`/tmp/serotine-e2e-server-${port}.log`;
 const log=fs.openSync(logPath,'w');
 const server=spawn(process.execPath,[root+'/node_modules/next/dist/bin/next','dev','--webpack','--port',port,'--hostname','127.0.0.1'],{cwd:root,stdio:['ignore',log,log]});let browser;
 let serverError;server.on('error',error=>{serverError=error});
 try{
  let serverReady=false;
  const readyUntil=Date.now()+120000;
  while(Date.now()<readyUntil){
   if(serverError||server.exitCode!==null)throw Error(`Browser test server failed: ${serverError?.message||server.exitCode}\n${fs.readFileSync(logPath,'utf8').slice(-5000)}`);
   try{const response=await fetch(origin,{signal:AbortSignal.timeout(3000)});if(response.ok){serverReady=true;break}}catch { /* Wait for the local server to start. */ }
   await sleep(500);
  }
  assert.equal(serverReady,true,`Browser test server was not ready; see ${logPath}`);
  browser=await chromium.launch({executablePath:process.env.SEROTINE_CHROMIUM_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],headless:true});
  const errors=[];const identities=await Promise.all([makeIdentity(),makeIdentity(),makeIdentity()]);const pages=[];
  async function makePage(identity){const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{try{if(r.url().includes('/api/relay')&&r.status()>=400) console.log('RELAY ERROR',r.status(),await r.text());else if(r.url().includes('/api/relay')) {const j=await r.json();if(j.success===false)console.log('RELAY FAILURE',j.error)}}catch(error){if(!/No data found for resource|navigated away|Target page, context or browser has been closed/.test(error.message))errors.push(error.message)}});
   // Engine peers use a plain same-origin document so Next development reloads
   // cannot erase their test globals. UI checks below navigate to the real app.
   await page.route(origin+'/__browser-integration-peer',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Serotine integration peer</title>'}));
   await page.goto(origin+'/__browser-integration-peer');await page.addScriptTag({content:bundle});if(identity)await page.evaluate(id=>localStorage.setItem('serotine_identity_v2',JSON.stringify(id)),identity);pages.push(page);return page}
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
  await b.evaluate(async peer=>{
    const identity=engine.identity,id=crypto.randomUUID();
    const envelope={version:3,id,sender:identity.publicKey,recipient:peer,content:'Legacy file caption',timestamp:Date.now(),attachments:[{name:'legacy.bin',type:'application/octet-stream',size:75000,data:btoa('%'.repeat(75000))}]};
    const encryptedData=await SerotineTest.encryptForPeer(JSON.stringify(envelope),await SerotineTest.importKey(identity.privateKey,'encryption','private'),peer);
    const data={id,recipientPubKey:peer,encryptedData};
    const result=await SerotineTest.storeEncryptedMessage(data,await SerotineTest.createRequestProof('message:send',data,identity.privateKey,identity.publicKey));
    if(!result.success)throw Error(result.error);
  },aid);
  await settle(()=>a.evaluate(()=>engine.model.messages.some(m=>m.attachment?.name==='legacy.bin')),'legacy file migration');
  assert.equal(await a.evaluate(async()=>{const m=engine.model.messages.find(m=>m.attachment?.name==='legacy.bin');const blob=await SerotineTest.assembleAttachment(m.attachment,engine.getAttachmentChunks(m.conversationId,m.id));return new Uint8Array(await blob.arrayBuffer()).every(byte=>byte===37)&&blob.size===75000}),true);
  assert.equal(await a.evaluate(async()=>{const identity=engine.identity,data={};const result=await SerotineTest.getLegacyInbox(data,await SerotineTest.createRequestProof('message:inbox',data,identity.privateKey,identity.publicKey));return result.success&&result.messages.length===0}),true);
  console.log('PASS older-client encrypted attachment receipt, byte integrity and durable acknowledgement');
  const backup=await a.evaluate(async()=>SerotineTest.exportFullBackup(engine.identity,'integration password 123'));
  const a2=await makePage();await a2.evaluate(async text=>SerotineTest.restoreBackup(text,'integration password 123'),backup);await start(a2);
  assert.equal(await a2.evaluate(async()=>{const m=engine.model.messages.find(m=>m.attachment?.name==='legacy.bin');const blob=await SerotineTest.assembleAttachment(m.attachment,engine.getAttachmentChunks(m.conversationId,m.id));return blob.size}),75000);
  await b.evaluate(peer=>engine.sendText(peer,'Both Alice devices'),aid);
  await settle(async()=>await a.evaluate(()=>engine.model.messages.some(m=>m.content==='Both Alice devices'))&&await a2.evaluate(()=>engine.model.messages.some(m=>m.content==='Both Alice devices')),'linked incoming');
  await a2.evaluate(peer=>engine.sendText(peer,'From linked Alice'),bid);
  await settle(async()=>await a.evaluate(()=>engine.model.messages.some(m=>m.content==='From linked Alice'))&&await b.evaluate(()=>engine.model.messages.some(m=>m.content==='From linked Alice')),'linked outgoing');
  console.log('PASS encrypted full backup and two-device incoming/outgoing synchronization');
  // Create through the actual UI: engine-only checks cannot detect a broken route.
  await a.evaluate(({owner,peers})=>SerotineTest.saveContacts(owner,peers),{owner:aid,peers:[{pub:bid,alias:'Bob'},{pub:cid,alias:'Carol'}]});
  await a.goto(origin+'/chat');
  await a.getByRole('button',{name:'Create group chat',exact:true}).click();
  const groupDialog=a.getByRole('dialog');
  await groupDialog.getByRole('textbox',{name:'Group name',exact:true}).fill('Browser-created group');
  await groupDialog.getByRole('checkbox',{name:/Bob/}).check();
  await groupDialog.getByRole('checkbox',{name:/Carol/}).check();
  await groupDialog.getByRole('button',{name:'Create group',exact:true}).click();
  await a.waitForURL(url=>decodeURIComponent(url.pathname).startsWith('/chat/group:'),{timeout:30000});
  const uiGroup=decodeURIComponent(new URL(a.url()).pathname.slice('/chat/'.length));
  const groupHref='/chat/'+encodeURIComponent(uiGroup);
  await a.getByRole('heading',{name:'Browser-created group',level:1,exact:true}).waitFor().catch(async error=>{throw Error(`${error.message}\nGroup route ${a.url()}\n${await a.locator('body').innerText()}`)});
  const messageBox=a.getByRole('textbox',{name:'Message',exact:true});
  await messageBox.waitFor({state:'visible'});
  assert.equal(await messageBox.isEnabled(),true,'new group composer must be usable');
  await a.goto(origin+'/chat');
  await a.getByRole('link',{name:/Browser-created group/}).click();
  await a.getByRole('heading',{name:'Browser-created group',level:1,exact:true}).waitFor();
  assert.equal(decodeURIComponent(new URL(a.url()).pathname),'/chat/'+uiGroup);
  await a.reload();
  await a.getByRole('heading',{name:'Browser-created group',level:1,exact:true}).waitFor();
  await messageBox.waitFor({state:'visible'});
  await settle(async()=>await b.evaluate(id=>engine.model.groups.some(g=>g.id===id),uiGroup)&&await c.evaluate(id=>engine.model.groups.some(g=>g.id===id),uiGroup),'UI group invite');
  await Promise.all([b,c].map(page=>page.evaluate(id=>engine.acceptRequest(id),uiGroup)));
  await messageBox.fill('Sent from the group message box');
  await a.getByRole('button',{name:'Send message',exact:true}).click();
  await settle(()=>c.evaluate(()=>engine.model.messages.some(m=>m.content==='Sent from the group message box')),'UI group message');
  await a.goto(origin+groupHref);
  await a.getByRole('heading',{name:'Browser-created group',level:1,exact:true}).waitFor();
  console.log('PASS actual group creation, sidebar navigation, reload and encrypted UI send');

  // Real DOM events exercise the conversation surface and textarea, not a hidden input alone.
  const messageHistory=a.getByRole('region',{name:'Conversation messages',exact:true});
  const historyText=messageHistory.getByText('Sent from the group message box',{exact:true});
  async function dropFiles(target,files){
    return target.evaluate((element,items)=>{
      const transfer=new DataTransfer();
      for(const item of items)transfer.items.add(new File([item.text],item.name,{type:item.type||'text/plain'}));
      const entering=new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:transfer});
      element.dispatchEvent(entering);
      const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer});
      element.dispatchEvent(over);
      const dropped=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer});
      element.dispatchEvent(dropped);
      return {overPrevented:over.defaultPrevented,dropPrevented:dropped.defaultPrevented};
    },files);
  }
  async function pasteFile(name,text){
    return messageBox.evaluate((element,item)=>{
      const transfer=new DataTransfer();transfer.items.add(new File([item.text],item.name,{type:'text/plain'}));
      const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});
      element.dispatchEvent(event);return event.defaultPrevented;
    },{name,text});
  }
  await messageBox.fill('Keep this draft');
  const textPastePrevented=await messageBox.evaluate(element=>{
    const transfer=new DataTransfer();transfer.setData('text/plain',' ordinary pasted text');
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer});
    element.dispatchEvent(event);return event.defaultPrevented;
  });
  assert.equal(textPastePrevented,false,'plain text paste must remain a native textarea operation');
  assert.equal(await messageBox.inputValue(),'Keep this draft','file handlers must not change text drafts');
  assert.equal(await pasteFile('clipboard.txt','Pasted file content'),true,'file paste must be captured');
  await a.getByText('clipboard.txt',{exact:false}).last().waitFor();
  assert.equal(await messageBox.inputValue(),'Keep this draft');
  await a.getByRole('button',{name:'Remove',exact:true}).click();
  assert.deepEqual(await dropFiles(historyText,[{name:'drop-first.txt',text:'First dropped file'},{name:'drop-second.txt',text:'Second dropped file'}]),{overPrevented:true,dropPrevented:true});
  await a.getByText('2 files queued · send them one at a time',{exact:true}).waitFor();
  await a.getByRole('button',{name:'Remove drop-second.txt',exact:true}).waitFor();
  await a.getByRole('button',{name:'Send file',exact:true}).click();
  await settle(()=>b.evaluate(()=>engine.model.messages.some(m=>m.attachment?.name==='drop-first.txt')),'dropped file send');
  await a.getByText('drop-second.txt',{exact:false}).last().waitFor();
  await a.getByRole('button',{name:'Send file',exact:true}).click();
  await settle(()=>b.evaluate(()=>engine.model.messages.some(m=>m.attachment?.name==='drop-second.txt')),'second queued file send');
  assert.equal(await messageBox.inputValue(),'Keep this draft');
  await messageBox.fill('');
  console.log('PASS clipboard files, unaffected text paste and multiple dropped files from nested message history');

  const compact=a.getByRole('checkbox',{name:'Auto compact files',exact:true});
  assert.equal(await compact.isChecked(),false,'auto compact is optional');
  await compact.check();
  await a.reload();
  await messageBox.waitFor({state:'visible'});
  assert.equal(await compact.isChecked(),true,'auto compact setting must survive reload');
  const compactText='Exact content survives automatic compression.\n'.repeat(2000);
  await pasteFile('compact-notes.txt',compactText);
  await a.getByText('compact-notes.txt.gz',{exact:false}).last().waitFor();
  await a.getByRole('button',{name:'Send file',exact:true}).click();
  await settle(()=>b.evaluate(()=>{const message=engine.model.messages.find(m=>m.attachment?.name==='compact-notes.txt.gz');return !!message&&engine.getAttachmentChunks(message.conversationId,message.id).length===message.attachment.chunks}),'compacted file receive');
  assert.equal(await b.evaluate(async()=>{
    const message=engine.model.messages.find(m=>m.attachment?.name==='compact-notes.txt.gz');
    const file=await SerotineTest.assembleAttachment(message.attachment,engine.getAttachmentChunks(message.conversationId,message.id));
    return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }),compactText,'auto compact must preserve the exact original file content');
  await compact.uncheck();
  await a.reload();
  await messageBox.waitFor({state:'visible'});
  assert.equal(await compact.isChecked(),false,'turning auto compact off must persist');
  console.log('PASS auto compact persistence, .gz filename and lossless received file content');

  const suggestions=a.getByRole('listbox',{name:'Mention suggestions',exact:true});
  await messageBox.pressSequentially('Keyboard mention @');
  await suggestions.waitFor();
  await messageBox.press('ArrowDown');
  await messageBox.press('ArrowUp');
  await messageBox.press('Enter');
  const keyboardMention=await messageBox.inputValue();
  assert.match(keyboardMention,/^Keyboard mention @(Bob|Carol) $/,'Enter should insert a visible mention without sending');
  const keyboardPeer=keyboardMention.includes('@Bob')?bid:cid;
  await a.getByRole('button',{name:'Send message',exact:true}).click();
  await settle(()=>b.evaluate(text=>engine.model.messages.some(m=>m.content===text),keyboardMention.trim()),'keyboard mention send');
  assert.deepEqual(await b.evaluate(text=>engine.model.messages.find(m=>m.content===text)?.mentions,keyboardMention.trim()),[keyboardPeer]);
  await messageBox.pressSequentially('Mouse mention @Car');
  await suggestions.getByRole('option',{name:/@Carol/}).click();
  const mouseMention=await messageBox.inputValue();
  assert.equal(mouseMention,'Mouse mention @Carol ');
  await a.reload();
  await messageBox.waitFor({state:'visible'});
  await a.getByRole('button',{name:'Remove mention of Carol',exact:true}).waitFor();
  assert.equal(await messageBox.inputValue(),mouseMention,'a draft mention must survive reload');
  await a.getByRole('button',{name:'Send message',exact:true}).click();
  await settle(()=>b.evaluate(text=>engine.model.messages.some(m=>m.content===text),mouseMention.trim()),'mouse mention send');
  assert.deepEqual(await b.evaluate(text=>engine.model.messages.find(m=>m.content===text)?.mentions,mouseMention.trim()),[cid]);
  await messageBox.pressSequentially('Removed mention @Bo');
  await messageBox.press('Tab');
  assert.equal(await messageBox.inputValue(),'Removed mention @Bob ');
  await messageBox.press('Backspace');
  for(let i=0;i<'@Bob'.length;i++)await messageBox.press('Backspace');
  await a.getByRole('button',{name:'Send message',exact:true}).click();
  await settle(()=>b.evaluate(()=>engine.model.messages.some(m=>m.content==='Removed mention')),'deleted mention send');
  assert.deepEqual(await b.evaluate(()=>engine.model.messages.find(m=>m.content==='Removed mention')?.mentions||[]),[],'deleted mention must not retain a notification target');
  console.log('PASS typed @ suggestions, keyboard and mouse insertion, real mention delivery and token deletion');

  await a.goto(origin+'/chat/'+aid);await a.getByRole('textbox',{name:'Message',exact:true}).waitFor({state:'visible',timeout:30000});await a.getByRole('textbox',{name:'Message',exact:true}).fill('Typed into self chat');await a.getByRole('button',{name:'Send message',exact:true}).click();await a.getByText('Typed into self chat',{exact:true}).last().waitFor({state:'visible',timeout:20000});
  await a.getByRole('button',{name:'Voice',exact:true}).click();await a.getByRole('button',{name:'Stop & preview',exact:true}).waitFor();await sleep(1200);await a.getByRole('button',{name:'Stop & preview',exact:true}).click();await a.getByRole('button',{name:'Send voice message',exact:true}).click();await a.locator('audio').first().waitFor({state:'visible'});console.log('PASS microphone permission, recording preview and voice-message send');await a.screenshot({path:'/tmp/serotine-desktop.png'});await a.setViewportSize({width:390,height:844});await a.screenshot({path:'/tmp/serotine-mobile.png'});
  assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'mobile must not overflow');
  console.log('PASS rendered self-chat composer on desktop and mobile');

  // A touch context catches oversized intrinsic controls that desktop resizing misses.
  const phoneContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,storageState:await a.context().storageState({indexedDB:true})});
  const phone=await phoneContext.newPage();phone.on('pageerror',error=>errors.push(error.message));
  await phone.goto(origin+'/chat');
  await phone.getByRole('complementary',{name:'Inbox',exact:true}).waitFor({state:'visible'});
  await phone.getByRole('complementary',{name:'Inbox',exact:true}).locator(`a[href="/chat/${aid}"]`).tap();
  const phoneMessage=phone.getByRole('textbox',{name:'Message',exact:true});
  await phoneMessage.waitFor({state:'visible'});
  assert.equal(await phone.getByRole('complementary',{name:'Inbox',exact:true}).isVisible(),false,'conversation replaces the inbox on a phone');
  await phoneMessage.fill('Sent from a touch phone');
  await phone.getByRole('button',{name:'Send message',exact:true}).tap();
  await phone.getByText('Sent from a touch phone',{exact:true}).last().waitFor({state:'visible'});
  async function checkPhoneLayout(width,height){
    await phone.setViewportSize({width,height});
    await phone.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height'))-window.visualViewport.height)<1);
    await phone.screenshot({path:`/tmp/serotine-phone-${width}x${height}.png`});
    const box=await phone.getByRole('button',{name:'Send message',exact:true}).boundingBox();
    assert.ok(box&&box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1,'send button stays in the visible phone viewport');
    assert.ok(box.width>=44&&box.height>=44,'send target supports touch');
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,'phone must not overflow horizontally');
    assert.equal(await phone.locator('footer').evaluate(node=>node.scrollWidth>node.clientWidth+1),false,'composer content must fit instead of being clipped');
  }
  await checkPhoneLayout(390,844);await checkPhoneLayout(320,568);
  // iOS can shrink only visualViewport, leaving innerHeight and dvh unchanged.
  await phone.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:340});Object.defineProperty(window.visualViewport,'offsetTop',{configurable:true,value:24});window.visualViewport.dispatchEvent(new Event('resize'))});
  await phone.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--app-height')==='340px');
  const keyboardSend=await phone.getByRole('button',{name:'Send message',exact:true}).boundingBox();
  assert.ok(keyboardSend&&keyboardSend.y>=24&&keyboardSend.y+keyboardSend.height<=364,'send button remains above an iOS-style keyboard');
  await phone.evaluate(()=>{delete window.visualViewport.height;delete window.visualViewport.offsetTop;window.visualViewport.dispatchEvent(new Event('resize'))});
  await phone.getByRole('link',{name:'Back to conversations',exact:true}).tap();
  assert.equal(await phone.getByRole('complementary',{name:'Inbox',exact:true}).evaluate(node=>node.scrollWidth>node.clientWidth+1),false,'inbox content must fit a 320px phone');
  await phone.getByRole('button',{name:'Backups and linked devices',exact:true}).tap();
  await phone.getByRole('button',{name:'Restore',exact:true}).tap();
  const phoneDialog=phone.getByRole('dialog');
  await phoneDialog.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
  await phoneDialog.getByLabel('Backup password',{exact:true}).fill('browser test password');
  await phone.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:300});window.visualViewport.dispatchEvent(new Event('resize'))});
  await phone.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--app-height')==='300px');
  await phoneDialog.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
  await phone.screenshot({path:'/tmp/serotine-phone-restore.png'});
  const dialogBounds=await phoneDialog.boundingBox();
  assert.ok(dialogBounds&&dialogBounds.x>=0&&dialogBounds.x+dialogBounds.width<=320&&dialogBounds.y>=0&&dialogBounds.y+dialogBounds.height<=300,`restore dialog stays within the visible viewport: ${JSON.stringify(dialogBounds)}`);
  assert.equal(await phoneDialog.evaluate(node=>node.scrollWidth>node.clientWidth+1),false,'restore dialog must not overflow horizontally');
  const passwordBounds=await phoneDialog.getByLabel('Backup password',{exact:true}).boundingBox();
  assert.ok(passwordBounds&&passwordBounds.y>=dialogBounds.y&&passwordBounds.y+passwordBounds.height<=dialogBounds.y+dialogBounds.height,'focused password stays visible above the keyboard');
  assert.ok(await phoneDialog.getByLabel('Backup password',{exact:true}).evaluate(node=>parseFloat(getComputedStyle(node).fontSize)>=16),'mobile password input avoids automatic zoom');
  await phoneDialog.getByRole('button',{name:'Close',exact:true}).tap();
  await phoneContext.close();
  console.log('PASS touch phone send, 320px layout, visual keyboard resize and scrollable backup restore dialog');
  assert.deepEqual(errors,[],'browser page errors');
  console.log('ALL BROWSER INTEGRATION CHECKS PASSED');
 }finally{await browser?.close();server.kill();fs.closeSync(log)}
})().catch(e=>{console.error(e);process.exitCode=1});
