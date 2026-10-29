import "./style.css";

(function(){
"use strict";

var LS={settings:"st_settings",draft:"st_draft",session:"st_active_session"};
var DB_NAME="speech_tracker_db",DB_VERSION=1;
var $=function(id){return document.getElementById(id);};
var stage=$("stage"),setup=$("setup"),results=$("results");

var state={
  event:null,
  index:0,
  phase:"setup",
  deadline:0,
  remainingMs:0,
  results:[],
  sound:true,
  keepAwake:true,
  ticker:null,
  endBeep:null,
  lastBeep:0,
  beepLevel:0,
  wakeLock:null
};

function showScreen(el){
  setup.classList.remove("active");
  stage.classList.remove("active");
  results.classList.remove("active");
  el.classList.add("active");
}

function toast(msg){
  var t=$("toast");
  t.textContent=msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer=setTimeout(function(){t.classList.remove("show");},2400);
}

function lsGet(key,fallback){
  try{
    var raw=localStorage.getItem(key);
    return raw?JSON.parse(raw):fallback;
  }catch(e){return fallback;}
}

function lsSet(key,value){
  try{localStorage.setItem(key,JSON.stringify(value));}catch(e){}
}

function uid(){
  return Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
}

function pad(n){return n<10?"0"+n:""+n;}

function fmtClock(seconds){
  var s=Math.max(0,Math.round(seconds));
  var h=Math.floor(s/3600);
  var m=Math.floor((s%3600)/60);
  var sec=s%60;
  if(h>0){return h+":"+pad(m)+":"+pad(sec);}
  return m+":"+pad(sec);
}

function fmtDate(ts){
  try{
    return new Date(ts).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
  }catch(e){return new Date(ts).toISOString();}
}
var dbPromise=null;

function openDb(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise(function(resolve){
    if(!window.indexedDB){resolve(null);return;}
    var req;
    try{req=indexedDB.open(DB_NAME,DB_VERSION);}catch(e){resolve(null);return;}
    req.onupgradeneeded=function(){
      var db=req.result;
      if(!db.objectStoreNames.contains("events")){db.createObjectStore("events",{keyPath:"id"});}
      if(!db.objectStoreNames.contains("results")){
        var store=db.createObjectStore("results",{keyPath:"id"});
        store.createIndex("eventId","eventId",{unique:false});
      }
    };
    req.onsuccess=function(){resolve(req.result);};
    req.onerror=function(){resolve(null);};
    req.onblocked=function(){resolve(null);};
  });
  return dbPromise;
}

function dbRun(storeName,mode,fn){
  return openDb().then(function(db){
    if(!db)return null;
    return new Promise(function(resolve,reject){
      var tx=db.transaction(storeName,mode);
      var req=fn(tx.objectStore(storeName));
      tx.onerror=function(){reject(tx.error);};
      if(req){
        req.onsuccess=function(){resolve(req.result);};
        req.onerror=function(){reject(req.error);};
      }else{
        resolve(null);
      }
    });
  }).catch(function(){return null;});
}

function dbPut(store,value){return dbRun(store,"readwrite",function(s){return s.put(value);});}
function dbGetAll(store){return dbRun(store,"readonly",function(s){return s.getAll? s.getAll():null;});}
function dbDelete(store,key){return dbRun(store,"readwrite",function(s){return s.delete(key);});}

function parseDuration(value){
  if(typeof value==="number"&&isFinite(value))return Math.round(value);
  if(typeof value!=="string")return null;
  var s=value.trim().toLowerCase();
  if(!s)return null;
  if(/^\d+(\.\d+)?$/.test(s))return Math.round(parseFloat(s));
  var m=s.match(/^(?:(\d+)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+)\s*(?:minutes?|mins?|m)\s*)?(?:(\d+)\s*(?:seconds?|secs?|s))?$/);
  if(m&&(m[1]||m[2]||m[3])){
    return parseInt(m[1]||"0",10)*3600+parseInt(m[2]||"0",10)*60+parseInt(m[3]||"0",10);
  }
  m=s.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if(m){
    if(m[3]!==undefined)return parseInt(m[1],10)*3600+parseInt(m[2],10)*60+parseInt(m[3],10);
    return parseInt(m[1],10)*60+parseInt(m[2],10);
  }
  return null;
}
var NAME_KEYS=["name","candidate","speaker","participant","contestant","student","label","title","fullName"];
var TIME_KEYS=["time","duration","timeLimit","limit","seconds","maxTime","allowed","allotted","totalTime","slot"];

function parseCandidates(raw){
  var data;
  try{data=JSON.parse(raw);}catch(e){throw new Error("Invalid JSON: "+e.message);}
  var list=null,eventName="";
  if(Array.isArray(data)){list=data;}
  else if(data&&typeof data==="object"){
    eventName=data.event||data.eventName||data.title||"";
    var keys=["candidates","speakers","participants","contestants","students","entries","list","items","rows","schedule","data"];
    for(var i=0;i<keys.length;i++){
      if(Array.isArray(data[keys[i]])){list=data[keys[i]];break;}
    }
    if(!list){
      var allKeys=Object.keys(data);
      for(var j=0;j<allKeys.length;j++){
        if(Array.isArray(data[allKeys[j]])){list=data[allKeys[j]];break;}
      }
    }
  }
  if(!list||!list.length){throw new Error('No candidates found. Expected {"candidates":[{"name":"...","time":180}]}');}
  var out=[],missing=0;
  list.forEach(function(item,idx){
    var name="",dur=null;
    if(typeof item==="string"){
      name=item.trim();
      var m=name.match(/^(.*?)\s*[-–—:]\s*(\d+(?::\d+){0,2}(?:\s*(?:s|sec|m|min))?)$/i);
      if(m){name=m[1].trim();dur=parseDuration(m[2]);}
    }else if(item&&typeof item==="object"){
      for(var k=0;k<NAME_KEYS.length;k++){
        if(item[NAME_KEYS[k]]){name=String(item[NAME_KEYS[k]]).trim();break;}
      }
      for(var t=0;t<TIME_KEYS.length;t++){
        if(item[TIME_KEYS[t]]!==undefined&&item[TIME_KEYS[t]]!==null&&item[TIME_KEYS[t]]!==""){
          dur=parseDuration(item[TIME_KEYS[t]]);
          if(dur!==null)break;
        }
      }
      if(dur===null&&item.minutes!==undefined){
        var mi=parseDuration(item.minutes);
        var se=item.seconds!==undefined?(parseDuration(item.seconds)||0):0;
        if(mi!==null)dur=mi*60+se;
      }
    }
    if(!name)name="Candidate "+(idx+1);
    if(dur===null||dur<=0){dur=60;missing++;}
    if(dur>14400)throw new Error("Time limit for "+name+" is over 4 hours.");
    out.push({name:name,allotted:dur});
  });
  return {name:eventName,candidates:out,defaulted:missing};
}

function buildEvent(){
  var raw=$("jsonInput").value.trim();
  if(!raw){throw new Error("Paste the candidates JSON first.");}
  var parsed=parseCandidates(raw);
  var name=$("eventName").value.trim()||parsed.name||"Untitled Event";
  return {
    id:uid(),
    name:name,
    createdAt:Date.now(),
    updatedAt:Date.now(),
    status:"active",
    candidates:parsed.candidates
  };
}
var audioCtx=null;

function ensureAudio(){
  try{
    if(!audioCtx){
      var C=window.AudioContext||window.webkitAudioContext;
      if(C)audioCtx=new C();
    }
    if(audioCtx&&audioCtx.state==="suspended")audioCtx.resume();
  }catch(e){}
}

function beep(freq,dur,gain,type){
  if(!state.sound)return;
  try{
    ensureAudio();
    if(!audioCtx)return;
    var osc=audioCtx.createOscillator();
    var vol=audioCtx.createGain();
    osc.type=type||"sine";
    osc.frequency.value=freq;
    var now=audioCtx.currentTime;
    vol.gain.setValueAtTime(0.0001,now);
    vol.gain.exponentialRampToValueAtTime(gain,now+0.012);
    vol.gain.exponentialRampToValueAtTime(0.0001,now+dur);
    osc.connect(vol);
    vol.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now+dur+0.03);
  }catch(e){}
}
var SFX_FILES={digital:{alarm:"sfx/mixkit-alarm.wav"},buzzer:{alarm:"sfx/mixkit-buzzer.wav"}};
var SFX={
  sharp:{
    warn:{notes:[[880,0.09,0.25,"square"],[880,0.09,0.25,"square"]],gap:140,every:2000},
    red:{notes:[[700,0.14,0.4,"square"],[700,0.14,0.4,"square"]],gap:170},
    urgent:{notes:[[1046,0.11,0.4,"square"],[1318,0.14,0.4,"square"]],gap:150,every:2000},
    crit:{notes:[[1244,0.17,0.55,"square"]],every:1000},
    alarm:[[1400,0.13,0.55,"square"],[950,0.13,0.55,"square"]],
    alarmEvery:330,
    start:{notes:[[740,0.08,0.3,"square"],[988,0.1,0.3,"square"]],gap:110},
    next:{notes:[[880,0.08,0.32,"square"],[1174,0.12,0.32,"square"]],gap:130}
  },
  classic:{
    warn:{notes:[[660,0.1,0.16,"sine"],[660,0.1,0.16,"sine"]],gap:150,every:2000},
    red:{notes:[[580,0.16,0.25,"sine"],[580,0.16,0.25,"sine"]],gap:180},
    urgent:{notes:[[880,0.13,0.3,"sine"],[1046,0.16,0.3,"sine"]],gap:160,every:2000},
    crit:{notes:[[1046,0.2,0.42,"sine"]],every:1000},
    alarm:[[900,0.15,0.42,"sine"],[700,0.15,0.42,"sine"]],
    alarmEvery:360,
    start:{notes:[[660,0.1,0.24,"sine"],[880,0.12,0.24,"sine"]],gap:120},
    next:{notes:[[784,0.1,0.26,"sine"],[1046,0.14,0.26,"sine"]],gap:140}
  },
  soft:{
    warn:{notes:[[740,0.1,0.2,"triangle"],[740,0.1,0.2,"triangle"]],gap:150,every:2000},
    red:{notes:[[620,0.16,0.3,"triangle"],[620,0.16,0.3,"triangle"]],gap:180},
    urgent:{notes:[[932,0.12,0.34,"triangle"],[1174,0.15,0.34,"triangle"]],gap:155,every:2000},
    crit:{notes:[[1100,0.19,0.5,"triangle"]],every:1000},
    alarm:[[1200,0.14,0.5,"triangle"],[850,0.14,0.5,"triangle"]],
    alarmEvery:340,
    start:{notes:[[700,0.09,0.26,"triangle"],[932,0.11,0.26,"triangle"]],gap:115},
    next:{notes:[[830,0.09,0.28,"triangle"],[1100,0.13,0.28,"triangle"]],gap:135}
  },
  digital:{
    warn:{notes:[[1000,0.08,0.2,"sine"],[1000,0.08,0.2,"sine"]],gap:130,every:2000},
    red:{notes:[[850,0.13,0.32,"sine"],[850,0.13,0.32,"sine"]],gap:160},
    urgent:{notes:[[1000,0.1,0.38,"sine"],[1300,0.13,0.38,"sine"]],gap:140,every:2000},
    crit:{notes:[[1400,0.16,0.5,"sine"]],every:1000},
    alarm:[[1200,0.13,0.5,"sine"],[1200,0.13,0.5,"sine"]],
    alarmEvery:330,
    start:{notes:[[900,0.08,0.26,"sine"],[1200,0.1,0.26,"sine"]],gap:110},
    next:{notes:[[1000,0.08,0.3,"sine"],[1400,0.12,0.3,"sine"]],gap:120}
  },
  buzzer:{
    warn:{notes:[[800,0.09,0.22,"square"],[800,0.09,0.22,"square"]],gap:130,every:2000},
    red:{notes:[[650,0.14,0.34,"square"],[650,0.14,0.34,"square"]],gap:160},
    urgent:{notes:[[900,0.11,0.42,"square"],[1200,0.14,0.42,"square"]],gap:145,every:2000},
    crit:{notes:[[1300,0.17,0.55,"square"]],every:1000},
    alarm:[[1300,0.13,0.55,"square"],[800,0.13,0.55,"square"]],
    alarmEvery:320,
    start:{notes:[[750,0.08,0.3,"square"],[1050,0.1,0.3,"square"]],gap:110},
    next:{notes:[[950,0.08,0.32,"square"],[1300,0.12,0.32,"square"]],gap:125}
  }
};

function playNotes(notes,gap){
  if(!notes||!notes.length)return;
  beep(notes[0][0],notes[0][1],notes[0][2],notes[0][3]);
  for(var i=1;i<notes.length;i++){
    (function(n,d){setTimeout(function(){beep(n[0],n[1],n[2],n[3]);},d);})(notes[i],gap*i);
  }
}

function cue(name){
  if(!state.sound)return;
  var files=SFX_FILES[state.soundPack];
  if(files&&files[name]){
    try{var a=new Audio(files[name]);a.play().catch(function(){});return;}catch(e){}
  }
  var pack=SFX[state.soundPack]||SFX.sharp;
  var c=pack[name];
  if(c&&c.notes)playNotes(c.notes,c.gap||0);
}

function requestWake(){
  if(!state.keepAwake)return;
  try{
    if(navigator.wakeLock&&navigator.wakeLock.request){
      navigator.wakeLock.request("screen").then(function(lock){state.wakeLock=lock;}).catch(function(){});
    }
  }catch(e){}
}

function releaseWake(){
  try{
    if(state.wakeLock&&state.wakeLock.release){state.wakeLock.release();}
  }catch(e){}
  state.wakeLock=null;
}

function saveSession(){
  if(!state.event)return;
  lsSet(LS.session,{
    event:state.event,
    index:state.index,
    phase:state.phase,
    deadline:state.deadline,
    results:state.results,
    savedAt:Date.now()
  });
}

function clearSession(){
  try{localStorage.removeItem(LS.session);}catch(e){}
}

function saveResult(entry){
  var record={
    id:state.event.id+":"+entry.index,
    eventId:state.event.id,
    eventName:state.event.name,
    index:entry.index,
    name:entry.name,
    allotted:entry.allotted,
    used:entry.used,
    left:entry.left,
    status:entry.status,
    finishedAt:Date.now()
  };
  dbPut("results",record);
  return record;
}

function markEventDone(){
  if(!state.event)return;
  state.event.status="completed";
  state.event.finishedAt=Date.now();
  state.event.updatedAt=Date.now();
  dbPut("events",state.event);
}
function currentCandidate(){
  if(!state.event||!state.event.candidates.length)return null;
  return state.event.candidates[Math.min(state.index,state.event.candidates.length-1)];
}

function toBn(str){
  return String(str).replace(/[0-9]/g,function(d){return "\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef".charAt(+d);});
}

function rollDigit(el,text){
  if(el.textContent===text||el._to===text)return;
  el._to=text;
  try{
    if(el._anim){el._anim.onfinish=null;el._anim.cancel();el._anim=null;}
    if(!el.animate){el.textContent=text;el._to=null;return;}
    var out=el.animate([
      {transform:"translateY(0)",opacity:1},
      {transform:"translateY(-38%)",opacity:0}
    ],{duration:90,easing:"ease-in",fill:"forwards"});
    el._anim=out;
    out.onfinish=function(){
      try{out.cancel();}catch(e){}
      el.textContent=text;
      el._to=null;
      el._anim=el.animate([
        {transform:"translateY(32%)",opacity:0},
        {transform:"translateY(0)",opacity:1}
      ],{duration:170,easing:"cubic-bezier(.2,.75,.3,1)"});
    };
  }catch(e){el.textContent=text;el._to=null;}
}

function renderTimer(seconds){
  var s=Math.max(0,Math.ceil(seconds));
  var m=pad(Math.floor(s/60)),sec=pad(s%60);
  if(state.clockLang==="bn"){m=toBn(m);sec=toBn(sec);}
  rollDigit($("minVal"),m);
  rollDigit($("secVal"),sec);
}

function renderStage(){
  if(!state.event)return;
  var c=currentCandidate();
  var name=c?c.name:"";
  $("candidateName").textContent=name;
  var box=$("timerBox"),nm=$("candidateName"),intro=$("introName");
  if(state.phase==="intro"){
    box.style.display="none";
    nm.style.display="none";
    intro.className="intro-name";
    void intro.offsetWidth;
    intro.textContent=name;
    intro.className="intro-name show";
  }else{
    box.style.display="flex";
    nm.style.display="block";
    if(!intro.classList.contains("out"))intro.className="intro-name";
    if(state.phase==="ready")renderTimer(c?c.allotted:0);
  }
}

function setStageColor(red,pulse){
  stage.classList.toggle("red",!!red);
  stage.classList.toggle("pulse",!!pulse);
}

function beepLevelFor(secs){
  if(secs<=0)return 4;
  if(secs<=5)return 3;
  if(secs<=15)return 2;
  if(secs<=30)return 1;
  return 0;
}

function tickBeeps(secs){
  if(!state.sound)return;
  var pack=SFX[state.soundPack]||SFX.sharp;
  var level=beepLevelFor(secs);
  if(level!==state.beepLevel){
    state.beepLevel=level;
    state.lastBeep=0;
  }
  if(secs<=60&&secs>0&&!state.redCued){
    state.redCued=true;
    cue("red");
  }
  if(level===0)return;
  var c=level===1?pack.warn:level===2?pack.urgent:pack.crit;
  var now=Date.now();
  if(now-state.lastBeep>=(c.every||2000)){
    cue(level===1?"warn":level===2?"urgent":"crit");
    state.lastBeep=now;
  }
}

function startTicker(){
  stopTicker();
  state.ticker=setInterval(tick,100);
}

function stopTicker(){
  if(state.ticker){clearInterval(state.ticker);state.ticker=null;}
}

function tick(){
  if(state.phase!=="running")return;
  var rem=Math.max(0,state.deadline-Date.now());
  state.remainingMs=rem;
  var secs=Math.ceil(rem/1000);
  renderTimer(rem/1000);
  setStageColor(secs<=60,secs<=5);
  tickBeeps(secs);
  if(rem<=0)onTimeUp();
}
function startSpeech(){
  var c=currentCandidate();
  if(!c)return;
  ensureAudio();
  state.phase="running";
  state.deadline=Date.now()+c.allotted*1000;
  state.remainingMs=c.allotted*1000;
  state.lastBeep=0;
  state.beepLevel=0;
  state.redCued=false;
  cue("start");
  setStageColor(false,false);
  renderStage();
  renderTimer(c.allotted);
  startTicker();
  requestWake();
  saveSession();
}

function startEndBeep(){
  stopEndBeep();
  if(!state.sound)return;
  var files=SFX_FILES[state.soundPack];
  if(files&&files.alarm){
    try{
      state.alarmAudio=new Audio(files.alarm);
      state.alarmAudio.loop=true;
      state.alarmAudio.play().catch(function(){});
      return;
    }catch(e){}
  }
  var pack=SFX[state.soundPack]||SFX.sharp;
  var i=0;
  state.endBeep=setInterval(function(){
    var n=pack.alarm[i%pack.alarm.length];i++;
    beep(n[0],n[1],n[2],n[3]);
  },pack.alarmEvery||330);
}

function stopEndBeep(){
  if(state.endBeep){clearInterval(state.endBeep);state.endBeep=null;}
  if(state.alarmAudio){try{state.alarmAudio.pause();}catch(e){}state.alarmAudio=null;}
}

function onTimeUp(){
  stopTicker();
  state.phase="ended";
  state.remainingMs=0;
  renderTimer(0);
  setStageColor(true,true);
  renderStage();
  startEndBeep();
  saveSession();
}

function finishSpeech(early){
  var c=currentCandidate();
  if(!c)return;
  stopTicker();
  stopEndBeep();
  var used,left;
  if(early&&state.phase==="running"){
    used=Math.max(0,Math.round(c.allotted-state.remainingMs/1000));
    left=Math.max(0,c.allotted-used);
  }else{
    used=c.allotted;
    left=0;
  }
  var entry={
    index:state.index,
    name:c.name,
    allotted:c.allotted,
    used:used,
    left:left,
    status:early?"early":"completed"
  };
  state.results.push(entry);
  saveResult(entry);
  setStageColor(false,false);
  advance();
}

function advance(){
  if(state.index<state.event.candidates.length-1){
    state.index++;
    showTransition();
  }else{
    showAllDone();
  }
  saveSession();
}

function showTransition(){
  state.phase="intro";
  setStageColor(false,false);
  cue("next");
  renderStage();
  saveSession();
}
function showAllDone(){
  state.phase="allDone";
  stopTicker();
  stopEndBeep();
  setStageColor(false,false);
  markEventDone();
  $("allDone").classList.add("show");
  saveSession();
  setTimeout(function(){
    if(state.phase==="allDone")showResults();
  },2000);
}

function showResults(){
  state.phase="results";
  stopTicker();
  stopEndBeep();
  setStageColor(false,false);
  $("allDone").classList.remove("show");
  renderResults();
  showScreen(results);
  clearSession();
  $("resumeBox").style.display="none";
}

function renderResults(){
  $("resTitle").textContent=state.event?state.event.name:"Results";
  $("resDate").textContent=state.event?fmtDate(state.event.createdAt):"";
  var totalUsed=0,totalLeft=0;
  state.results.forEach(function(r){totalUsed+=r.used;totalLeft+=r.left;});
  $("statCount").textContent=state.results.length;
  $("statTime").textContent=fmtClock(totalUsed);
  $("statLeft").textContent=fmtClock(totalLeft);
  var body=$("resBody");
  body.innerHTML="";
  state.results.forEach(function(r,i){
    var tr=document.createElement("tr");
    var tdRank=document.createElement("td");
    tdRank.className="c-rank";
    var n=document.createElement("span");
    n.className="rank-n"+(i===0?" top":"");
    n.textContent=String(i+1);
    tdRank.appendChild(n);
    var tdName=document.createElement("td");
    tdName.className="c-name";
    tdName.textContent=r.name;
    var tdLimit=document.createElement("td");
    tdLimit.className="c-num";
    tdLimit.textContent=fmtClock(r.allotted);
    var tdUsed=document.createElement("td");
    tdUsed.className="c-num";
    tdUsed.textContent=fmtClock(r.used);
    var tdLeft=document.createElement("td");
    tdLeft.className="c-num";
    var spanLeft=document.createElement("span");
    spanLeft.textContent=fmtClock(r.left);
    if(r.left<=0){spanLeft.style.color="#dc2626";spanLeft.style.fontWeight="800";}
    else if(r.status==="early"){spanLeft.style.color="#769656";spanLeft.style.fontWeight="800";}
    tdLeft.appendChild(spanLeft);
    tr.appendChild(tdRank);tr.appendChild(tdName);tr.appendChild(tdLimit);tr.appendChild(tdUsed);tr.appendChild(tdLeft);
    body.appendChild(tr);
  });
}
var ctxWrap=$("ctxWrap"),ctxMenu=$("ctxMenu");
var lpTimer=null,lpXY=null,ctxSuppress=false;

function menuOpen(){return !ctxWrap.hidden;}

function openCtx(){
  if(state.phase!=="running"&&state.phase!=="ended")return;
  ctxWrap.hidden=false;
  ctxSuppress=true;
}

function closeCtx(){
  if(!menuOpen())return;
  ctxWrap.hidden=true;
  ctxSuppress=false;
}

function addTime(ms){
  if(!ms||isNaN(ms))return;
  if(state.phase==="running"){
    state.deadline+=ms;
  }else if(state.phase==="ended"){
    state.deadline=Date.now()+ms;
    state.phase="running";
    stopEndBeep();
    state.beepLevel=0;
    state.lastBeep=0;
    startTicker();
    requestWake();
  }else return;
  var secs=Math.max(0,Math.ceil((state.deadline-Date.now())/1000));
  if(secs>60)state.redCued=false;
  renderTimer(secs);
  setStageColor(secs<=60,secs<=5);
  cue("next");
  saveSession();
}

Array.prototype.forEach.call(ctxMenu.querySelectorAll(".ctx-item[data-add]"),function(btn){
  btn.addEventListener("click",function(e){
    e.stopPropagation();
    addTime(parseInt(btn.getAttribute("data-add"),10)*1000);
    closeCtx();
  });
});

$("ctxClose").addEventListener("click",function(e){
  e.stopPropagation();
  closeCtx();
});

ctxWrap.addEventListener("pointerdown",function(e){e.stopPropagation();});
ctxWrap.addEventListener("click",function(e){
  e.stopPropagation();
  if(e.target===ctxWrap)closeCtx();
});

function cancelLP(){if(lpTimer){clearTimeout(lpTimer);lpTimer=null;}}

stage.addEventListener("pointerdown",function(e){
  if(state.phase!=="running"&&state.phase!=="ended")return;
  if(menuOpen())return;
  lpXY={x:e.clientX,y:e.clientY};
  cancelLP();
  lpTimer=setTimeout(function(){
    lpTimer=null;
    openCtx();
  },500);
});
stage.addEventListener("pointermove",function(e){
  if(!lpTimer||!lpXY)return;
  if(Math.abs(e.clientX-lpXY.x)>12||Math.abs(e.clientY-lpXY.y)>12)cancelLP();
});
stage.addEventListener("pointerup",cancelLP);
stage.addEventListener("pointercancel",cancelLP);
stage.addEventListener("contextmenu",function(e){
  if(state.phase!=="running"&&state.phase!=="ended")return;
  e.preventDefault();
  openCtx();
});

stage.addEventListener("click",function(){
  if(ctxSuppress){ctxSuppress=false;return;}
  ensureAudio();
  if(state.phase==="intro"){
    var intro=$("introName");
    intro.classList.remove("show");
    intro.classList.add("out");
    startSpeech();
    var box=$("timerBox"),nm=$("candidateName");
    box.classList.add("enter");
    nm.classList.add("enter");
    setTimeout(function(){
      intro.className="intro-name";
      box.classList.remove("enter");
      nm.classList.remove("enter");
    },430);
  }
  else if(state.phase==="ready"){startSpeech();}
  else if(state.phase==="running"){finishSpeech(true);}
  else if(state.phase==="ended"){finishSpeech(false);}
  else if(state.phase==="allDone"){showResults();}
});

function saveSettings(){lsSet(LS.settings,{sound:state.sound,keepAwake:state.keepAwake,soundPack:state.soundPack,clockLang:state.clockLang});}

function saveDraft(){
  lsSet(LS.draft,{name:$("eventName").value,json:$("jsonInput").value});
}

$("eventName").addEventListener("input",saveDraft);
$("jsonInput").addEventListener("input",saveDraft);

$("soundToggle").addEventListener("change",function(){
  state.sound=!!this.checked;
  if(!state.sound)stopTest();
  saveSettings();
});

$("sfxSelect").addEventListener("change",function(){
  state.soundPack=this.value;
  saveSettings();
  cue("start");
});

$("numLang").addEventListener("change",function(){
  state.clockLang=this.value;
  saveSettings();
});

$("wakeToggle").addEventListener("change",function(){
  state.keepAwake=!!this.checked;
  saveSettings();
});

function stopTest(){
  if(state.testAudio){
    try{state.testAudio.pause();}catch(e){}
    state.testAudio=null;
    $("testBtn").textContent="\u266a Test";
  }
}

$("testBtn").addEventListener("click",function(){
  if(state.testAudio){stopTest();return;}
  ensureAudio();
  var files=SFX_FILES[state.soundPack];
  if(files&&files.alarm){
    try{
      var a=new Audio(files.alarm);
      state.testAudio=a;
      $("testBtn").textContent="\u25a0 Stop";
      a.onended=function(){if(state.testAudio===a){state.testAudio=null;$("testBtn").textContent="\u266a Test";}};
      a.play().catch(function(){stopTest();});
      return;
    }catch(e){}
  }
  cue("warn");
  setTimeout(function(){cue("urgent");},500);
});

$("sampleBtn").addEventListener("click",function(){
  var sample={
    candidates:[
      {name:"Aisha Rahman",time:180},
      {name:"Rakib Hasan",time:"2:30"},
      {name:"Chen Wei",time:"90s"},
      {name:"Sofia Mendes",time:"2m"},
      {name:"Omar Farouk",time:120}
    ]
  };
  $("jsonInput").value=JSON.stringify(sample,null,2);
  if(!$("eventName").value.trim())$("eventName").value="Sample Debate Round";
  $("setupMsg").textContent="";
  saveDraft();
});

$("clearBtn").addEventListener("click",function(){
  $("jsonInput").value="";
  $("setupMsg").textContent="";
  saveDraft();
});

$("startBtn").addEventListener("click",function(){
  try{
    var ev=buildEvent();
    state.event=ev;
    state.index=0;
    state.results=[];
    state.phase="intro";
    state.remainingMs=0;
    $("setupMsg").textContent="";
    $("resumeBox").style.display="none";
    dbPut("events",ev);
    showScreen(stage);
    setStageColor(false,false);
    renderStage();
    var c=currentCandidate();
    if(c)renderTimer(c.allotted);
    saveSession();
  }catch(e){
    $("setupMsg").textContent=e.message||String(e);
  }
});
function loadRecent(){
  dbGetAll("events").then(function(list){
    var ul=$("recentList");
    ul.innerHTML="";
    if(!list||!list.length){
      var empty=document.createElement("div");
      empty.style.fontSize="13px";
      empty.style.color="#555";
      empty.textContent="No events yet.";
      ul.appendChild(empty);
      return;
    }
    list.sort(function(a,b){return (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0);});
    list.slice(0,8).forEach(function(ev){
      var li=document.createElement("li");
      li.style.display="flex";
      li.style.alignItems="center";
      li.style.gap="10px";
      li.style.padding="10px 0";
      li.style.borderTop="1px solid #e5e5e5";
      var info=document.createElement("div");
      info.style.flex="1";
      info.style.minWidth="0";
      var nm=document.createElement("div");
      nm.style.fontWeight="600";
      nm.style.fontSize="14px";
      nm.style.overflow="hidden";
      nm.style.textOverflow="ellipsis";
      nm.style.whiteSpace="nowrap";
      nm.textContent=ev.name;
      var meta=document.createElement("div");
      meta.style.fontSize="12px";
      meta.style.color="#555";
      var cnt=(ev.candidates&&ev.candidates.length)||0;
      meta.textContent=cnt+" candidates · "+(ev.status==="completed"?"Done":"Active");
      info.appendChild(nm);info.appendChild(meta);
      var loadBtn=document.createElement("button");
      loadBtn.type="button";
      loadBtn.className="btn btn-sm";
      loadBtn.style.border="1px solid #000";
      loadBtn.style.background="#769656";
      loadBtn.style.color="#000";
      loadBtn.textContent="Load";
      loadBtn.addEventListener("click",function(e){
        e.stopPropagation();
        $("eventName").value=ev.name||"";
        $("jsonInput").value=JSON.stringify({candidates:ev.candidates},null,2);
        saveDraft();
        toast("Loaded "+(ev.name||"event"));
      });
      var delBtn=document.createElement("button");
      delBtn.type="button";
      delBtn.className="btn btn-sm btn-outline btn-error";
      delBtn.textContent="Del";
      delBtn.addEventListener("click",function(e){
        e.stopPropagation();
        dbDelete("events",ev.id);
        setTimeout(loadRecent,150);
      });
      li.appendChild(info);li.appendChild(loadBtn);li.appendChild(delBtn);
      ul.appendChild(li);
    });
  });
}

$("newEventBtn").addEventListener("click",function(){
  clearSession();
  state.event=null;
  state.index=0;
  state.results=[];
  state.phase="setup";
  showScreen(setup);
  loadRecent();
});

$("copyBtn").addEventListener("click",function(){
  var payload={
    event:state.event?state.event.name:"",
    date:state.event?new Date(state.event.createdAt).toISOString():"",
    results:state.results
  };
  var text=JSON.stringify(payload,null,2);
  function fallbackCopy(){
    var ta=document.createElement("textarea");
    ta.value=text;
    ta.style.position="fixed";
    ta.style.opacity="0";
    document.body.appendChild(ta);
    ta.select();
    try{document.execCommand("copy");toast("Results copied.");}catch(e){toast("Copy failed.");}
    document.body.removeChild(ta);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){toast("Results copied.");},fallbackCopy);
  }else{fallbackCopy();}
});

function resumeSession(){
  var session=state._session;
  if(!session||!session.event)return;
  state.event=session.event;
  state.index=session.index||0;
  state.results=session.results||[];
  var phase=session.phase||"ready";
  $("resumeBox").style.display="none";
  if(phase==="running"&&session.deadline){
    var rem=session.deadline-Date.now();
    if(rem<=0){phase="ended";state.remainingMs=0;state.deadline=session.deadline;}
    else{state.remainingMs=rem;state.deadline=session.deadline;}
  }
  if(phase==="results"){showResults();return;}
  if(phase==="allDone"){showScreen(stage);showAllDone();return;}
  state.phase=phase==="transition"?"intro":phase;
  showScreen(stage);
  setStageColor(false,false);
  renderStage();
  if(state.phase==="running"){
    renderTimer(state.remainingMs/1000);
    startTicker();
    requestWake();
  }else if(state.phase==="ended"){
    renderTimer(0);
    setStageColor(true,true);
    startEndBeep();
  }else{
    var c=currentCandidate();
    if(c)renderTimer(c.allotted);
  }
}

$("resumeBtn").addEventListener("click",resumeSession);

function init(){
  var settings=lsGet(LS.settings,{sound:true,keepAwake:true,soundPack:"sharp",clockLang:"en"});
  state.sound=settings.sound!==false;
  state.keepAwake=settings.keepAwake!==false;
  state.soundPack=settings.soundPack||"sharp";
  state.clockLang=settings.clockLang||"en";
  $("soundToggle").checked=state.sound;
  $("wakeToggle").checked=state.keepAwake;
  $("sfxSelect").value=state.soundPack;
  $("numLang").value=state.clockLang;
  var draft=lsGet(LS.draft,null);
  if(draft){
    $("eventName").value=draft.name||"";
    $("jsonInput").value=draft.json||"";
  }
  var session=lsGet(LS.session,null);
  if(session&&session.event){
    state._session=session;
    $("resumeBox").style.display="block";
    $("resumeBtn").textContent="Resume: "+session.event.name;
  }
  loadRecent();
}

init();
})();
