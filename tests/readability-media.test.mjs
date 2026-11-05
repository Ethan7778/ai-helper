import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://chatgpt.com/', pretendToBeVisual: true });
for (const name of ['window','document','HTMLElement','Element','HTMLTextAreaElement','HTMLButtonElement','HTMLInputElement','MutationObserver','Event','CustomEvent','DOMRect','ShadowRoot','Node','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) globalThis[name] = typeof dom.window[name] === 'function' && ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name];
const originalRect=dom.window.Element.prototype.getBoundingClientRect;
dom.window.Element.prototype.getBoundingClientRect=function(){const r=originalRect.call(this);r.toJSON=()=>({x:r.x,y:r.y,width:r.width,height:r.height});return r;};
globalThis.innerWidth=1280; globalThis.innerHeight=800;
globalThis.CSS={ escape: s=>s };
globalThis.ResizeObserver=class { observe(){} disconnect(){} };
const preferences = {}; const listeners = new Set();
globalThis.chrome={runtime:{id:'test'}, storage:{local:{ get(keys,cb){ cb(Object.fromEntries(keys.map(k=>[k,preferences[k]]))); }, set(data,cb){Object.assign(preferences,data); cb?.(); for(const fn of listeners)fn(Object.fromEntries(Object.entries(data).map(([k,v])=>[k,{newValue:v}])),'local');}},onChanged:{addListener(fn){listeners.add(fn)},removeListener(fn){listeners.delete(fn)}}}};
const dir=mkdtempSync(join(tmpdir(),'ai-helper-media-'));
const load=async (name)=>{const path=join(dir,name+'.mjs'); await build({entryPoints:['extension/'+name+'.ts'],bundle:true,format:'esm',platform:'node',outfile:path,logLevel:'silent'});return import(pathToFileURL(path));};
try {
 const {formatReplyHtml,cleanChatGptText}=await load('core/text-clean');
 const render=text=>{const el=document.createElement('div');el.innerHTML=formatReplyHtml(text);return el;};
 let el=render('| Item | Value |\n| --- | --- |\n| A | **B** |\n\n> quoted\n>\n> - first\n> - second\n\n1. parent\n   - child');
 assert.equal(el.querySelectorAll('td').length,2); assert.equal(el.querySelector('td strong').textContent,'B'); assert.equal(el.querySelectorAll('blockquote li').length,2); assert(el.querySelector('ol ul li'));
 for(const fence of ['```','~~~']) {
  el=render(`${fence}python\ndef hello():\n    return "<safe>"\n${fence}`);
  assert.equal(el.querySelector('pre code').textContent,'def hello():\n    return "<safe>"'); assert(el.querySelector('.hljs-keyword')); assert(el.querySelector('.hljs-string'));
 }
 el=render('```javascript\nconst x = "unfinished";'); assert.equal(el.querySelector('code').textContent,'const x = "unfinished";');
 el=render('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)');
 assert.equal(el.querySelectorAll('img,script').length,0); assert.equal(el.querySelectorAll('a').length,1); assert.equal(el.querySelector('a').rel,'noopener noreferrer');
 assert(cleanChatGptText('    const x = 1;').startsWith('    '));
 assert.equal(render('    first\n    second').querySelector('pre').textContent.trim(),'first\nsecond');
 assert.equal(cleanChatGptText('~~~js\n  image_group{"x": 1}\n~~~'),'~~~js\n  image_group{"x": 1}\n~~~');
 const writing=render('Send them this 😂\n\n:::writing{variant="chat_message" id="58321" title="CS girlfriend joke"}\nBro I just saw a joke.\n\n**The punchline.**\n:::\n\nOutside card.');
 assert.equal(writing.querySelector('.writing-title').textContent,'CS girlfriend joke');
 assert.equal(writing.querySelector('.writing-content strong').textContent,'The punchline.');
 assert(!writing.textContent.includes(':::'));assert(!writing.textContent.includes('variant='));assert(writing.lastElementChild.textContent.includes('Outside card.'));
 const partial=render(':::writing{title="Draft"}\nIncomplete **draft');assert(partial.querySelector('.writing-card'));assert(!partial.textContent.includes(':::'));
 const codeCard=render(':::writing{title="Example"}\n```text\n:::\n```\n:::');assert.equal(codeCard.querySelector('.writing-card code').textContent,':::');
 assert.equal(render('```text\n:::writing{title="Literal"}\nbody\n:::\n```').querySelectorAll('.writing-card').length,0);
 const badTitle=render(':::writing{title="<img src=x onerror=alert(1)>"}\nSafe\n:::');assert.equal(badTitle.querySelectorAll('img').length,0);assert(badTitle.textContent.includes('<img'));
 const {normalizeTextSize,DEFAULT_TEXT_SIZE}=await load('core/types');assert.equal(DEFAULT_TEXT_SIZE,15);assert.equal(normalizeTextSize(undefined),15);assert.equal(normalizeTextSize(22),18);assert.equal(normalizeTextSize(10),12);
 console.log('PASS: writing cards, streamed partials, code-literal markers, safe titles, seven text-size stops');
 const math=render(String.raw`Inline \(x^2\) and display \[\frac{1}{2}\]`);
 assert(math.querySelector('math msup'));assert(math.querySelector('.math-display math mfrac'));
 assert.equal(render('`$x$`').querySelectorAll('math').length,0);
 console.log('PASS: tables, nested lists, boxed quotes, fence variants, indentation, syntax colors, XSS filtering, existing MathML support');
 const {uploadChatGptImages,uploadClaudeImages,uploadGeminiImages}=await load('background/image-upload');
 const picture={id:'image',name:'screen.png',mimeType:'image/png',dataUrl:'data:image/png;base64,YWJj',previewDataUrl:'data:image/jpeg;base64,YWJj',width:20,height:10};
 let calls=[]; globalThis.fetch=async(url,init)=>{calls.push({url,init}); if(url.endsWith('/files'))return Response.json({file_id:'f1',upload_url:'https://test.blob.core.windows.net/picture'});return Response.json({});};
 const uploaded=await uploadChatGptImages([picture],'secret');assert.equal(calls.length,3);assert.equal(calls[1].init.credentials,'omit');assert(!JSON.stringify(calls[1].init.headers).includes('secret')); assert.equal(uploaded.parts[0].asset_pointer,'file-service://f1');
 globalThis.fetch=async()=>Response.json({file_uuid:'claude-file'});assert.deepEqual(await uploadClaudeImages([picture],'org'),['claude-file']);
 globalThis.fetch=async()=>new Response('/contrib_service/ttl_1d/pic');assert.deepEqual(await uploadGeminiImages([picture],'push'),[[['/contrib_service/ttl_1d/pic'],'screen.png']]);
 globalThis.fetch=async()=>new Response('unavailable',{status:403});await assert.rejects(()=>uploadGeminiImages([picture],'push'),/HTTP 403/);
 console.log('PASS: provider upload payloads, signed URL credential isolation, upload failures');
 const request={type:'ask-follow-up',siteId:'chatgpt',threadId:'t',messageId:'m',quotedText:'quote',surroundingContext:'',conversationExcerpt:'',question:'What is in this picture?',images:[picture]};
 let posted;
 const {completeViaChatGptSession}=await load('background/chatgpt-session');
 globalThis.fetch=async(url,init={})=>{
   if(url.endsWith('/files'))return Response.json({file_id:'f1',upload_url:'https://test.blob.core.windows.net/picture'});
   if(url.includes('blob.core.windows.net')||url.endsWith('/uploaded'))return Response.json({status:'success'});
   if(url.includes('chat-requirements'))return Response.json({token:'requirements'});
   if(url.endsWith('/models'))return Response.json({models:[{slug:'test-model'}]});
   if(url.endsWith('/conversation')){posted=JSON.parse(init.body);return new Response('data: '+JSON.stringify({conversation_id:'c',message:{id:'a',author:{role:'assistant'},content:{parts:['A picture.']},status:'finished_successfully',end_turn:true}})+'\n\ndata: [DONE]\n\n');}
   throw new Error('Unexpected test request '+url);
 };
 const result=await completeViaChatGptSession({accessToken:'token',userAgent:'test'},request);
 assert(result.ok,result.error);assert.equal(posted.messages[0].content.content_type,'multimodal_text');assert.equal(posted.messages[0].content.parts[0].asset_pointer,'file-service://f1');assert.equal(posted.messages[0].metadata.attachments[0].id,'f1');
 const {completeViaClaudeSession}=await load('background/claude-session');
 globalThis.fetch=async(url,init={})=>{
   if(url.endsWith('/organizations'))return Response.json([{uuid:'org',capabilities:['chat']}]);
   if(url.endsWith('/upload'))return Response.json({file_uuid:'claude-image'});
   if(url.endsWith('/chat_conversations'))return Response.json({uuid:'conv',is_temporary:true});
   if(url.endsWith('/completion')){posted=JSON.parse(init.body);return new Response('');}
   throw new Error('Unexpected test request '+url);
 };
 await completeViaClaudeSession({...request,siteId:'claude'});assert.deepEqual(posted.files,['claude-image']);
 const tokenScript=document.createElement('script');tokenScript.textContent='{"cfb2h":"build","SNlM0e":"at","FdrFJe":"sid","qKIAYe":"push"}';document.head.append(tokenScript);
 const {completeViaGeminiSession}=await load('background/gemini-session');
 globalThis.location=dom.window.location;
 globalThis.fetch=async(url,init={})=>{
   if(url.includes('content-push'))return new Response('/contrib_service/ttl_1d/pic');
   if(url.includes('StreamGenerate')){posted=JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1]);return new Response('');}
   throw new Error('Unexpected test request '+url);
 };
 await completeViaGeminiSession({...request,siteId:'gemini'});assert.deepEqual(posted[0][3],[[['/contrib_service/ttl_1d/pic'],'screen.png']]);
 console.log('PASS: all three session clients pass uploaded picture references into their generation requests');

 const {Sidebar,HOST_ID}=await load('core/sidebar');
 let sent; const thread={id:'thread',messageId:'main',anchorStart:0,anchorEnd:4,quotedText:'test',replies:[]};
 const sidebar=new Sidebar({onFocusThread(){},onDeleteThread(){},onAppearanceChange(){},onAnswerLengthChange(){},onSummaryChange(){},async onSend(t,q,partial,images){sent={q,images};return {ok:false,error:'Test upload failure'};}});
 sidebar.setThreads([thread]);sidebar.focusThread('thread');await new Promise(r=>setTimeout(r,20));
 const shadow=document.getElementById(HOST_ID).shadowRoot;
 // Exercise a real paste -> preparation -> preview -> send -> retry/removal flow.
 globalThis.Image=class {naturalWidth=100;naturalHeight=100;decode(){return Promise.resolve();}};
 const originalCreate=document.createElement.bind(document);
 document.createElement=(tag,...args)=>{const node=originalCreate(tag,...args); if(tag==='canvas'){node.getContext=()=>({fillRect(){},drawImage(){}});node.toDataURL=type=>`data:${type};base64,YWJj`;}return node;};
 const file=new File(['test'],'photo.jpg',{type:'image/jpeg'});
 const paste=new window.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{files:[file]}});shadow.querySelector('textarea').dispatchEvent(paste);await new Promise(r=>setTimeout(r,20));
 assert.equal(shadow.querySelectorAll('.image-preview').length,1);
 shadow.querySelector('.send').click();await new Promise(r=>setTimeout(r,20));
 assert.equal(sent.images.length,1);assert.equal(sent.images[0].name,'photo.png');assert(sent.q);assert.equal(shadow.querySelectorAll('.image-preview').length,1);assert.match(shadow.querySelector('.status').textContent,/Test upload failure/);
 shadow.querySelector('.image-preview button').click();assert.equal(shadow.querySelectorAll('.image-preview').length,0);
 sidebar.openSettings();const select=shadow.querySelector('#sidebar-text-size');assert.equal(select.type,'range');assert.equal(select.min,'0');assert.equal(select.max,'6');assert.equal(select.step,'1');assert.equal(shadow.querySelectorAll('.text-size-ticks span').length,7);assert.equal(shadow.querySelector('.text-size-settings').previousElementSibling.textContent,'Appearance');select.value='5';select.dispatchEvent(new window.Event('input'));select.dispatchEvent(new window.Event('change'));await new Promise(r=>setTimeout(r,20));assert.equal(preferences['ui:textSize'],17);assert.equal(document.getElementById(HOST_ID).style.getPropertyValue('--reply-text-size'),'17px');
 sidebar.destroy();const restored=new Sidebar({onFocusThread(){},onDeleteThread(){},onSend:async()=>({ok:true}),onAppearanceChange(){},onAnswerLengthChange(){},onSummaryChange(){}});await new Promise(r=>setTimeout(r,20));assert.equal(restored.describe().textSize,17);restored.destroy();
 console.log('PASS: paste, image preview, attachment-only send, draft recovery, removal, text-size persistence');
 // Deterministic geometry tests: fixed overlay covers right half, then clears.
 document.createElement=originalCreate;
 const {installUnderlineLayer,scheduleUnderlineLayout}=await load('core/underline');
 const mark=document.createElement('mark');mark.dataset.threadId='x';mark.dataset.aiHelperUnderline='#00f';mark.textContent='highlight';document.body.append(mark);
 mark.getClientRects=()=>[new DOMRect(20,100,120,20)];
 const cover=document.createElement('div');document.body.append(cover);let covering=true;
 document.elementFromPoint=(x,y)=>covering&&x>80?cover:mark;
 const cleanup=installUnderlineLayer();await new Promise(r=>setTimeout(r,40));
 let lines=[...document.querySelectorAll('svg[data-ai-helper-underlines] line')];assert(lines.length);assert(lines.every(line=>+line.getAttribute('x2')<=80));
 covering=false;scheduleUnderlineLayout();await new Promise(r=>setTimeout(r,40));
 // schedule must invalidate hit tests even when text geometry is unchanged.
 lines=[...document.querySelectorAll('svg[data-ai-helper-underlines] line')];assert(lines.some(line=>+line.getAttribute('x2')===140));
 cleanup();console.log('PASS: underline splits around occlusion and recovers after overlay clears');
 const panel=document.createElement('form');panel.style.cssText='position:fixed;background:white;opacity:1';
 const editor=document.createElement('textarea');editor.style.opacity='1';panel.append(editor);document.body.append(panel);
 editor.getBoundingClientRect=()=>new DOMRect(10,650,600,80);panel.getBoundingClientRect=()=>new DOMRect(0,620,640,120);
 document.elementFromPoint=(x,y)=>y>=620?editor:mark;
 const unmount=installUnderlineLayer();await new Promise(r=>setTimeout(r,40));
 const masks=[...document.querySelectorAll('mask rect[fill="black"]')];assert(masks.some(rect=>+rect.getAttribute('y')<=620 && +rect.getAttribute('y') + +rect.getAttribute('height')===800));
 unmount();console.log('PASS: composer mask includes the upper gutter and extends below a floating editor');
} finally {dom.window.close();rmSync(dir,{recursive:true,force:true});}
