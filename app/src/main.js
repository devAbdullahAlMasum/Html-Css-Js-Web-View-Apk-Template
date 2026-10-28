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

function renderTimer(seconds){
  var s=Math.max(0,Math.ceil(seconds));
  $("minVal").textContent=pad(Math.floor(s/60));
  $("secVal").textContent=pad(s%60);
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
  var level=beepLevelFor(secs);
  if(level!==state.beepLevel){
    state.beepLevel=level;
    state.lastBeep=0;
  }
  if(level===0)return;
  var now=Date.now();
  if(level===1){
    if(now-state.lastBeep>=2000){beep(660,0.10,0.07);state.lastBeep=now;}
  }else if(level===2){
    if(now-state.lastBeep>=2000){beep(880,0.16,0.26);state.lastBeep=now;}
  }else if(level===3){
    if(now-state.lastBeep>=1000){beep(1046,0.20,0.34);state.lastBeep=now;}
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
  setStageColor(false,false);
  renderStage();
  renderTimer(c.allotted);
  startTicker();
  requestWake();
  saveSession();
}

function startEndBeep(){
  stopEndBeep();
  state.endBeep=setInterval(function(){
    beep(1180,0.16,0.4);
  },330);
}

function stopEndBeep(){
  if(state.endBeep){clearInterval(state.endBeep);state.endBeep=null;}
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
    var badge=document.createElement("span");
    badge.className="badge badge-sm"+(i===0?" badge-warning":" badge-ghost");
    badge.style.border="1px solid #000";
    badge.style.color="#000";
    badge.textContent=String(i+1);
    tdRank.appendChild(badge);
    var tdName=document.createElement("td");
    tdName.style.fontWeight="600";
    tdName.textContent=r.name;
    var tdLimit=document.createElement("td");
    tdLimit.textContent=fmtClock(r.allotted);
    var tdUsed=document.createElement("td");
    tdUsed.textContent=fmtClock(r.used);
    var tdLeft=document.createElement("td");
    var spanLeft=document.createElement("span");
    spanLeft.textContent=fmtClock(r.left);
    if(r.left<=0){spanLeft.style.color="#dc2626";spanLeft.style.fontWeight="700";}
    else if(r.status==="early"){spanLeft.style.color="#769656";spanLeft.style.fontWeight="700";}
    tdLeft.appendChild(spanLeft);
    tr.appendChild(tdRank);tr.appendChild(tdName);tr.appendChild(tdLimit);tr.appendChild(tdUsed);tr.appendChild(tdLeft);
    body.appendChild(tr);
  });
}
stage.addEventListener("click",function(){
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

function saveSettings(){lsSet(LS.settings,{sound:state.sound,keepAwake:state.keepAwake});}

function saveDraft(){
  lsSet(LS.draft,{name:$("eventName").value,json:$("jsonInput").value});
}

$("eventName").addEventListener("input",saveDraft);
$("jsonInput").addEventListener("input",saveDraft);

$("soundToggle").addEventListener("change",function(){
  state.sound=!!this.checked;
  saveSettings();
});

$("wakeToggle").addEventListener("change",function(){
  state.keepAwake=!!this.checked;
  saveSettings();
});

$("testBtn").addEventListener("click",function(){
  ensureAudio();
  beep(880,0.15,0.25);
  setTimeout(function(){beep(1046,0.18,0.3);},160);
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
  var settings=lsGet(LS.settings,{sound:true,keepAwake:true});
  state.sound=settings.sound!==false;
  state.keepAwake=settings.keepAwake!==false;
  $("soundToggle").checked=state.sound;
  $("wakeToggle").checked=state.keepAwake;
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
