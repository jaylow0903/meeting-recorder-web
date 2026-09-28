const $=s=>document.querySelector(s);
const DB_NAME='MeetingRecorderWebDB', DB_VER=1;
let db, micStream=null, sysStream=null, micRecorder=null, sysRecorder=null;
let micChunks=[], sysChunks=[], recording=false, recordStart=0, timerHandle=null;
let audioCtx=null, micAnalyser=null, sysAnalyser=null, selectedMeetingId=null;
let whisper=null, transformersMod=null, currentNoiseBaseline=null;

const ui={
 secure:$('#secureStatus'),project:$('#project'),meeting:$('#meeting'),
 micMeter:$('#micMeter'),sysMeter:$('#sysMeter'),micState:$('#micState'),sysState:$('#sysState'),
 micWave:$('#micWave'),sysWave:$('#sysWave'),timer:$('#timer'),notes:$('#audioNotes'),
 warnings:$('#warnings'),rows:$('#meetingRows'),editor:$('#transcriptEditor'),
 transcribeStatus:$('#transcribeStatus'),speakerLibrary:$('#speakerLibrary')
};

function warn(msg){ ui.warnings.textContent=msg+'\n'+ui.warnings.textContent.slice(0,3500); }
function fmt(sec){sec=Math.max(0,Math.floor(sec));return [sec/3600|0,(sec%3600)/60|0,sec%60].map(x=>String(x).padStart(2,'0')).join(':')}
function uuid(){return crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(16).slice(2)}
function safeName(s){return (s||'Meeting').replace(/[<>:"/\\|?*]+/g,'_').slice(0,80)}

function openDB(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(DB_NAME,DB_VER);
  req.onupgradeneeded=()=>{
   const d=req.result;
   if(!d.objectStoreNames.contains('meetings')) d.createObjectStore('meetings',{keyPath:'id'});
   if(!d.objectStoreNames.contains('speakers')) d.createObjectStore('speakers',{keyPath:'name'});
  };
  req.onsuccess=()=>{db=req.result;resolve(db)}; req.onerror=()=>reject(req.error);
 });
}
function tx(store,mode='readonly'){return db.transaction(store,mode).objectStore(store)}
function idbPut(store,val){return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(val);r.onsuccess=()=>res(val);r.onerror=()=>rej(r.error)})}
function idbGet(store,key){return new Promise((res,rej)=>{const r=tx(store).get(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function idbAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}

async function ensureAudioCtx(){
 if(!audioCtx) audioCtx=new (window.AudioContext||window.webkitAudioContext)();
 if(audioCtx.state==='suspended') await audioCtx.resume();
}
async function connectMic(){
 try{
  await ensureAudioCtx();
  micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false}});
  micAnalyser=audioCtx.createAnalyser();micAnalyser.fftSize=2048;
  audioCtx.createMediaStreamSource(micStream).connect(micAnalyser);
  ui.micState.textContent='Connected';$('#btnMic').textContent='Microphone Connected ✓'; drawLoop();
 }catch(e){warn('Microphone connection failed: '+e.message)}
}
async function connectSystem(){
 try{
  await ensureAudioCtx();
  const display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
  const tracks=display.getAudioTracks();
  if(!tracks.length){display.getTracks().forEach(t=>t.stop());throw new Error('No shared audio track. Choose a tab/screen and enable Share audio.')}
  sysStream=new MediaStream(tracks);
  sysAnalyser=audioCtx.createAnalyser();sysAnalyser.fftSize=2048;
  audioCtx.createMediaStreamSource(sysStream).connect(sysAnalyser);
  ui.sysState.textContent='Shared audio connected';$('#btnSystem').textContent='System Audio Connected ✓'; drawLoop();
 }catch(e){warn('System audio not connected: '+e.message)}
}
function analyserStats(an){
 if(!an)return {rms:0,peak:0,wave:null};
 const arr=new Float32Array(an.fftSize);an.getFloatTimeDomainData(arr);
 let sum=0,peak=0;for(const v of arr){sum+=v*v;peak=Math.max(peak,Math.abs(v))}
 return {rms:Math.sqrt(sum/arr.length),peak,wave:arr};
}
function drawWave(canvas,arr){
 const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
 c.clearRect(0,0,w,h);c.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#2563eb';
 c.lineWidth=2;c.beginPath();
 if(!arr){c.moveTo(0,h/2);c.lineTo(w,h/2)}else{
  for(let i=0;i<arr.length;i++){const x=i/(arr.length-1)*w,y=h/2-arr[i]*h*.42;i?c.lineTo(x,y):c.moveTo(x,y)}
 } c.stroke();
}
let drawing=false;
function drawLoop(){
 if(drawing)return;drawing=true;
 const tick=()=>{
  const m=analyserStats(micAnalyser),s=analyserStats(sysAnalyser);
  ui.micMeter.style.width=Math.min(100,Math.sqrt(m.rms)*220)+'%';
  ui.sysMeter.style.width=Math.min(100,Math.sqrt(s.rms)*220)+'%';
  if(micAnalyser) ui.micState.textContent=m.peak>.98?'CLIPPING':m.rms<.004?'Very low / quiet':'GOOD';
  if(sysAnalyser) ui.sysState.textContent=s.rms<.002?'Idle / quiet':'GOOD';
  drawWave(ui.micWave,m.wave);drawWave(ui.sysWave,s.wave);
  requestAnimationFrame(tick);
 };tick();
}

function makeRecorder(stream,chunks){
 const opts={};if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))opts.mimeType='audio/webm;codecs=opus';
 const r=new MediaRecorder(stream,opts);r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};return r;
}
async function startRecording(){
 if(recording)return;
 if(!micStream)await connectMic();
 if(!micStream)return;
 micChunks=[];sysChunks=[];
 micRecorder=makeRecorder(micStream,micChunks);micRecorder.start(1000);
 if(sysStream){sysRecorder=makeRecorder(sysStream,sysChunks);sysRecorder.start(1000)}
 recording=true;recordStart=Date.now();$('#btnStart').disabled=true;$('#btnStop').disabled=false;
 timerHandle=setInterval(()=>ui.timer.textContent=fmt((Date.now()-recordStart)/1000),250);
 warn('Recording started. Optional tests can still be run.');
}
async function stopRecording(){
 if(!recording)return;
 const stops=[];
 if(micRecorder&&micRecorder.state!=='inactive')stops.push(new Promise(r=>{micRecorder.onstop=r;micRecorder.stop()}));
 if(sysRecorder&&sysRecorder.state!=='inactive')stops.push(new Promise(r=>{sysRecorder.onstop=r;sysRecorder.stop()}));
 await Promise.all(stops);
 clearInterval(timerHandle);recording=false;$('#btnStart').disabled=false;$('#btnStop').disabled=true;
 const duration=(Date.now()-recordStart)/1000;
 const micBlob=new Blob(micChunks,{type:micChunks[0]?.type||'audio/webm'});
 const sysBlob=sysChunks.length?new Blob(sysChunks,{type:sysChunks[0]?.type||'audio/webm'}):null;
 const id=uuid(), now=new Date();
 const meeting={
  id,created:now.toISOString(),project:ui.project.value.trim(),meeting:ui.meeting.value.trim(),
  duration,micBlob,sysBlob,transcript:'',chunks:[],detectedLanguage:'',audioQuality:null,
  noiseBaseline:currentNoiseBaseline,reviewedSegments:[],speakerMatches:[]
 };
 meeting.audioQuality=await analyzeBlob(micBlob);
 await idbPut('meetings',meeting); selectedMeetingId=id;ui.timer.textContent=fmt(duration);
 await refreshMeetings();await selectMeeting(id); warn('Recording saved locally in this browser.');
}

async function analyzeBlob(blob){
 try{
  await ensureAudioCtx();const ab=await blob.arrayBuffer();const b=await audioCtx.decodeAudioData(ab.slice(0));
  const d=b.getChannelData(0);let sum=0,peak=0,z=0,last=d[0]||0;
  for(let i=0;i<d.length;i++){const v=d[i];sum+=v*v;peak=Math.max(peak,Math.abs(v));if((v>=0)!=(last>=0))z++;last=v}
  return {duration:b.duration,sampleRate:b.sampleRate,rms:Math.sqrt(sum/d.length),peak,zeroCrossRate:z/d.length};
 }catch(e){return {error:e.message}}
}

async function measure(kind){
 if(!micStream)await connectMic();if(!micAnalyser)return;
 const start=Date.now(),vals=[],dur=10000;
 ui.notes.textContent=(kind==='noise'?'ROOM NOISE TEST: nobody speak for 10 seconds.':'VOICE TEST: speak normally for 10 seconds.');
 await new Promise(resolve=>{
  const t=setInterval(()=>{const st=analyserStats(micAnalyser);vals.push(st.rms);if(Date.now()-start>=dur){clearInterval(t);resolve()}},100);
 });
 vals.sort((a,b)=>a-b);const p=q=>vals[Math.min(vals.length-1,Math.floor(vals.length*q))]||0;
 if(kind==='noise'){currentNoiseBaseline={p20:p(.2),p50:p(.5),p90:p(.9),measured:new Date().toISOString()};ui.notes.textContent='Room baseline captured. Recording remains optional/unblocked.'}
 else ui.notes.textContent=`Voice test complete. Typical RMS ${p(.7).toFixed(4)}; peak-window ${p(.95).toFixed(4)}.`;
}

async function refreshMeetings(){
 const all=(await idbAll('meetings')).sort((a,b)=>b.created.localeCompare(a.created));ui.rows.innerHTML='';
 for(const m of all){
  const tr=document.createElement('tr');tr.dataset.id=m.id;if(m.id===selectedMeetingId)tr.classList.add('selected');
  tr.innerHTML=`<td>${new Date(m.created).toLocaleString()}</td><td>${esc(m.project)}</td><td>${esc(m.meeting)}</td><td>${fmt(m.duration)}</td><td>${m.transcript?'Ready':'Audio only'}</td>`;
  tr.addEventListener('click',()=>selectMeeting(m.id));ui.rows.appendChild(tr);
 }
}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function selectMeeting(id){
 selectedMeetingId=id;const m=await idbGet('meetings',id);if(!m)return;
 ui.editor.value=m.transcript||'';$('#btnTranscribe').disabled=!whisper;$('#btnExport').disabled=false;
 [...ui.rows.children].forEach(r=>r.classList.toggle('selected',r.dataset.id===id));
}

async function loadWhisper(){
 ui.transcribeStatus.textContent='Loading Transformers.js…';
 try{
  transformersMod=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm');
  const {pipeline,env}=transformersMod;
  env.allowLocalModels=false;
  ui.transcribeStatus.textContent='Downloading/caching multilingual Whisper model (first time only)…';
  whisper=await pipeline('automatic-speech-recognition','Xenova/whisper-small',{device:'wasm',dtype:'q8'});
  ui.transcribeStatus.textContent='Browser Whisper READY. Model is cached by the browser for reuse.';
  $('#btnTranscribe').disabled=!selectedMeetingId;
 }catch(e){ui.transcribeStatus.textContent='Whisper load failed: '+e.message;warn('Browser Whisper could not load. Browser SpeechRecognition fallback can still be added later.')}
}

async function blobTo16k(blob){
 await ensureAudioCtx();const ab=await blob.arrayBuffer(),buf=await audioCtx.decodeAudioData(ab.slice(0));
 const mono=new Float32Array(buf.length);for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<d.length;i++)mono[i]+=d[i]/buf.numberOfChannels}
 if(buf.sampleRate===16000)return mono;
 const frames=Math.ceil(buf.duration*16000),off=new OfflineAudioContext(1,frames,16000),src=off.createBufferSource(),b=off.createBuffer(1,mono.length,buf.sampleRate);
 b.copyToChannel(mono,0);src.buffer=b;src.connect(off.destination);src.start();const rendered=await off.startRendering();return rendered.getChannelData(0).slice();
}
async function createTranscript(){
 if(!whisper||!selectedMeetingId)return;
 const m=await idbGet('meetings',selectedMeetingId);ui.transcribeStatus.textContent='Transcribing locally in browser…';
 try{
  const audio=await blobTo16k(m.micBlob);
  const out=await whisper(audio,{return_timestamps:true,chunk_length_s:30,stride_length_s:5,task:'transcribe'});
  m.transcript=(out.text||'').trim();m.chunks=(out.chunks||[]).map((c,i)=>({id:i,start:c.timestamp?.[0]??0,end:c.timestamp?.[1]??0,text:(c.text||'').trim()}));
  m.detectedLanguage='auto';m.transcriptionEngine='Transformers.js + Xenova/whisper-small';m.transcriptionAt=new Date().toISOString();
  m.speakerMatches=await inferSpeakers(audio,m.chunks,16000);
  m.transcript=formatTranscript(m);
  await idbPut('meetings',m);ui.editor.value=m.transcript;ui.transcribeStatus.textContent='Transcript READY. Review/edit or export to ChatGPT.';await refreshMeetings();
 }catch(e){ui.transcribeStatus.textContent='Transcription failed: '+e.message;warn('Transcription failed: '+e.message)}
}
function formatTranscript(m){
 if(!m.chunks?.length)return m.transcript||'';
 return m.chunks.map((c,i)=>{
  const sm=m.speakerMatches?.[i];const who=sm?.label?` ${sm.label}:`:' ROOM:';
  return `[${fmt(c.start)}]${who} ${c.text}`;
 }).join('\n');
}

function segmentSignature(audio,start,end,sr){
 const a=Math.max(0,Math.floor(start*sr)),b=Math.min(audio.length,Math.floor(end*sr));if(b-a<sr*.5)return null;
 const slice=audio.subarray(a,b),bands=new Float64Array(16);let rms=0,z=0,last=slice[0]||0;
 for(let i=0;i<slice.length;i++){const v=slice[i];rms+=v*v;if((v>=0)!=(last>=0))z++;last=v}
 rms=Math.sqrt(rms/slice.length);
 // lightweight Goertzel band energies from ~100Hz to 4kHz
 const freqs=[100,150,220,320,450,600,800,1000,1250,1500,1800,2200,2600,3000,3500,4000];
 const step=Math.max(1,Math.floor(slice.length/(sr*4))); // cap work
 for(let bi=0;bi<freqs.length;bi++){
  const f=freqs[bi],w=2*Math.PI*f/sr,co=2*Math.cos(w);let s0=0,s1=0,s2=0,n=0;
  for(let i=0;i<slice.length;i+=step){s0=slice[i]+co*s1-s2;s2=s1;s1=s0;n++}
  bands[bi]=Math.log1p(Math.max(0,s1*s1+s2*s2-co*s1*s2)/(n||1));
 }
 const max=Math.max(...bands,1e-9);return [rms,z/slice.length,...[...bands].map(x=>x/max)];
}
function cosine(a,b){if(!a||!b||a.length!==b.length)return 0;let d=0,aa=0,bb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]}return d/(Math.sqrt(aa*bb)+1e-9)}
async function inferSpeakers(audio,chunks,sr){
 const speakers=await idbAll('speakers');return chunks.map(c=>{
  const sig=segmentSignature(audio,c.start,c.end,sr);let best=null,score=0;
  for(const p of speakers){const sc=cosine(sig,p.signature);if(sc>score){score=sc;best=p}}
  if(!best||score<.82)return {label:'Unknown Speaker',score};
  if(score<.9)return {label:`Possible: ${best.name}`,score};
  return {label:best.name,score};
 });
}
async function importReview(file){
 if(!selectedMeetingId)return warn('Select a meeting first.');
 try{
  const data=JSON.parse(await file.text()),m=await idbGet('meetings',selectedMeetingId);
  if(!m)return;
  const audio=await blobTo16k(m.micBlob);
  m.reviewedSegments=data.segments||[];
  for(const seg of m.reviewedSegments){
   if(seg.text_corrected){
    const ix=m.chunks?.findIndex(c=>Math.abs(c.start-seg.start)<1.1&&Math.abs(c.end-seg.end)<1.5);
    if(ix>=0)m.chunks[ix].text=seg.text_corrected;
   }
   if(seg.confirmed&&seg.speaker&&seg.end>seg.start){
    const sig=segmentSignature(audio,seg.start,seg.end,16000);if(!sig)continue;
    const old=await idbGet('speakers',seg.speaker);
    if(old){
     const n=old.samples||1;old.signature=old.signature.map((v,i)=>(v*n+sig[i])/(n+1));old.samples=n+1;old.updated=new Date().toISOString();await idbPut('speakers',old);
    }else await idbPut('speakers',{name:seg.speaker,company:seg.company||'',samples:1,signature:sig,updated:new Date().toISOString()});
   }
  }
  m.speakerMatches=await inferSpeakers(audio,m.chunks||[],16000);m.transcript=formatTranscript(m);await idbPut('meetings',m);ui.editor.value=m.transcript;
  await refreshSpeakers();warn('AI-reviewed transcript imported. Confirmed speaker segments updated the local Speaker Library.');
 }catch(e){warn('AI review import failed: '+e.message)}
}
async function refreshSpeakers(){
 const all=(await idbAll('speakers')).sort((a,b)=>b.samples-a.samples);ui.speakerLibrary.innerHTML='';
 if(!all.length){ui.speakerLibrary.innerHTML='<div class="muted">No confirmed speakers learned yet.</div>';return}
 for(const p of all){const d=document.createElement('div');d.className='speaker-card';d.innerHTML=`<div class="speaker-name">${esc(p.name)}</div><div class="speaker-meta">${p.company?esc(p.company)+' • ':''}${p.samples} confirmed sample(s) • updated ${new Date(p.updated).toLocaleDateString()}</div>`;ui.speakerLibrary.appendChild(d)}
}

async function saveTranscriptEdit(){
 if(!selectedMeetingId)return;const m=await idbGet('meetings',selectedMeetingId);m.transcript=ui.editor.value;await idbPut('meetings',m);warn('Transcript edit saved locally.');
}


function crc32(bytes){
  let c=0xffffffff;
  for(let i=0;i<bytes.length;i++){
    c^=bytes[i];
    for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);
  }
  return (c^0xffffffff)>>>0;
}
function u16(n){return [n&255,(n>>>8)&255]}
function u32(n){return [n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]}
function zipStore(files){
  const enc=new TextEncoder(),locals=[],centrals=[];let offset=0;
  for(const [name,value] of Object.entries(files)){
    const nameB=enc.encode(name),data=value instanceof Uint8Array?value:new Uint8Array(value);
    const crc=crc32(data);
    const local=new Uint8Array([
      ...u32(0x04034b50),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),
      ...u32(crc),...u32(data.length),...u32(data.length),...u16(nameB.length),...u16(0),
      ...nameB,...data
    ]);
    locals.push(local);
    const central=new Uint8Array([
      ...u32(0x02014b50),...u16(20),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),
      ...u32(crc),...u32(data.length),...u32(data.length),...u16(nameB.length),...u16(0),...u16(0),
      ...u16(0),...u16(0),...u32(0),...u32(offset),...nameB
    ]);
    centrals.push(central);offset+=local.length;
  }
  const centralSize=centrals.reduce((n,x)=>n+x.length,0),count=centrals.length;
  const end=new Uint8Array([
    ...u32(0x06054b50),...u16(0),...u16(0),...u16(count),...u16(count),
    ...u32(centralSize),...u32(offset),...u16(0)
  ]);
  const total=offset+centralSize+end.length,out=new Uint8Array(total);let p=0;
  for(const x of locals){out.set(x,p);p+=x.length}
  for(const x of centrals){out.set(x,p);p+=x.length}
  out.set(end,p);return out;
}
function strU8(s){return new TextEncoder().encode(s)}

function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}
async function exportMeeting(){
 if(!selectedMeetingId)return;const m=await idbGet('meetings',selectedMeetingId);if(!m)return;
 const reviewTemplate={version:'1.0',meeting_id:m.id,segments:(m.chunks||[]).map(c=>({start:c.start,end:c.end,speaker:'',company:'',text_original:c.text,text_corrected:c.text,confirmed:false}))};
 const meta={id:m.id,created:m.created,project:m.project,meeting:m.meeting,duration:m.duration,detected_language:m.detectedLanguage,transcription_engine:m.transcriptionEngine,audio_quality:m.audioQuality,noise_baseline:m.noiseBaseline,speaker_matches:m.speakerMatches};
 const instructions=`# Meeting Package for ChatGPT

## Primary task
1. Repair/correct the transcript first using the supplied transcript, timestamps, audio evidence, project context and natural language logic.
2. Preserve uncertain wording as uncertain; do not invent missing facts.
3. Return AI_Reviewed_Transcript.json with the same start/end timestamps and corrected text.
4. Set speaker and confirmed=true only when identity is strongly supported.
5. After transcript repair, prepare the MOM if requested.

## Speaker learning rule
Only confirmed=true segments will train the local Speaker Library.
`;
 const transcript=m.transcript||'';
 const waveform=JSON.stringify({audioQuality:m.audioQuality,noiseBaseline:m.noiseBaseline,chunks:m.chunks||[]},null,2);
 const files={
  'ChatGPT_Input.md':strU8(instructions+'\n## Transcript\n\n'+transcript),
  'meeting_info.json':strU8(JSON.stringify(meta,null,2)),
  'AI_Reviewed_Transcript_TEMPLATE.json':strU8(JSON.stringify(reviewTemplate,null,2)),
  'audio_timing_waveform.json':strU8(waveform),
  'room_mic.webm':new Uint8Array(await m.micBlob.arrayBuffer())
 };
 if(m.sysBlob)files['remote_system.webm']=new Uint8Array(await m.sysBlob.arrayBuffer());
 const zipped=zipStore(files);downloadBlob(new Blob([zipped],{type:'application/zip'}),`ChatGPT_Package_${safeName(m.project)}_${safeName(m.meeting)}.zip`);
}

document.addEventListener('DOMContentLoaded',async()=>{
 await openDB();await refreshMeetings();await refreshSpeakers();
 const secure=window.isSecureContext;
 ui.secure.textContent=secure?'Secure context ✓':'Needs HTTPS / localhost';
 if(!secure)warn('Microphone and screen audio require HTTPS or localhost. Do not open index.html directly from file://.');
 if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
 $('#btnMic').onclick=connectMic;$('#btnSystem').onclick=connectSystem;$('#btnStart').onclick=startRecording;$('#btnStop').onclick=stopRecording;
 $('#btnNoise').onclick=()=>measure('noise');$('#btnVoiceTest').onclick=()=>measure('voice');
 $('#btnRefreshMeetings').onclick=refreshMeetings;$('#btnLoadWhisper').onclick=loadWhisper;$('#btnTranscribe').onclick=createTranscript;$('#btnExport').onclick=exportMeeting;
 $('#btnRefreshSpeakers').onclick=refreshSpeakers;$('#btnSaveTranscript').onclick=saveTranscriptEdit;
 $('#reviewImport').onchange=e=>{const f=e.target.files?.[0];if(f)importReview(f)};
});
