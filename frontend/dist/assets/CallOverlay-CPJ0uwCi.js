import{_ as Mt,u as Lt,P as Dt,m as Et,e as Ft,d as It,M as jt}from"./index-DM0uD_O-.js";import{r as f,j as R}from"./vendor-query-D8-W16Rz.js";import{i as xt,L as At,b as qt,W as Bt,a as Kt,O as Ot,C as Nt,z as wt,R as kt,u as Ct,T as _t,c as Wt,s as $t,d as zt}from"./index-DpPLIr_7.js";import{X as Ht}from"./ChatsPage-BM5Kg_fW.js";import"./vendor-react-DyfnzrEv.js";import"./vendor-socket-CA1CrNgP.js";import"./vendor-crypto-C7xP7Q7Y.js";function Ut(y={}){const[u,_]=f.useState(!1),[F,C]=f.useState(!1),[z,W]=f.useState(!1);let X=xt().microphoneTrack;const[B,j]=f.useState();y.trackRef&&(X=y.trackRef.publication);const L=f.useCallback(async K=>{if(K){const{KrispNoiseFilter:I,isKrispNoiseFilterSupported:J}=await Mt(async()=>{const{KrispNoiseFilter:tt,isKrispNoiseFilterSupported:Z}=await import("./index-Cc9ouniY.js");return{KrispNoiseFilter:tt,isKrispNoiseFilterSupported:Z}},[]);if(!J()){At.warn("LiveKit-Krisp noise filter is not supported in this browser");return}B||j(I(y.filterOptions))}_(I=>(I!==K&&C(!0),K))},[]);return f.useEffect(()=>{var K;if(X&&X.track instanceof qt&&B){const I=X.track.getProcessor();I&&I.name==="livekit-noise-filter"?(C(!0),I.setEnabled(u).finally(()=>{C(!1),W(u)})):!I&&u&&(C(!0),(K=X?.track)==null||K.setProcessor(B).then(()=>B.setEnabled(u)).then(()=>{W(!0)}).catch(J=>{W(!1),At.error("Krisp hook: error enabling filter",J)}).finally(()=>{C(!1)}))}},[u,X,B]),{setNoiseFilterEnabled:L,isNoiseFilterEnabled:z,isNoiseFilterPending:F,processor:B}}if(typeof window<"u"&&typeof navigator<"u"&&navigator.mediaDevices&&!window.__eblushaEnumeratePatched){const y=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=>{const u=await y(),_=navigator.userAgent||"";if(!/iP(ad|hone|od)/i.test(_))return u;const C=[],z=[],W=[],X=(j,L)=>{const K=j.toLowerCase();return/(front|перед|selfie|true depth|ultra wide front)/.test(K)?"front":/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(K)||/(back|rear)/.test(L.toLowerCase())?"back":"other"};u.forEach(j=>{if(j.kind!=="videoinput"){W.push(j);return}const L=X(j.label||"",j.deviceId||"");L==="front"?C.push(j):z.push(j)});const B=[];if(C.length>0&&B.push(C[0]),z.length>0&&B.push(z[0]),B.length===0&&u.some(j=>j.kind==="videoinput")){const j=u.find(L=>L.kind==="videoinput");j&&B.push(j)}return W.forEach(j=>{j.kind!=="videoinput"&&B.push(j)}),B},window.__eblushaEnumeratePatched=!0}try{$t(zt.warn)}catch{}const at={aec:"eb.lk.webrtc.aec",ns:"eb.lk.webrtc.ns",agc:"eb.lk.webrtc.agc",krisp:"eb.lk.krisp.enabled"};function yt(y,u){if(typeof window>"u")return u;try{const _=window.localStorage.getItem(y);return _===null?u:_==="1"||_==="true"}catch{return u}}function mt(y,u){if(!(typeof window>"u"))try{window.localStorage.setItem(y,u?"1":"0")}catch{}}function dt(y,u){if(typeof window>"u")return!1;try{const F=new URLSearchParams(window.location.search).get(u);if(F==="1"||F==="true")return!0;const C=window.localStorage.getItem(y);return C==="1"||C==="true"}catch{return!1}}function vt({label:y,description:u,checked:_,onChange:F,disabled:C=!1,rightHint:z}){return R.jsxs("div",{className:"eb-toggle-row",children:[R.jsxs("div",{className:"eb-toggle-text",children:[R.jsx("div",{className:"eb-toggle-label",children:y}),u?R.jsx("div",{className:"eb-toggle-desc",children:u}):null]}),R.jsxs("div",{className:"eb-toggle-right",children:[z?R.jsx("div",{className:"eb-toggle-hint",children:z}):null,R.jsxs("label",{className:`eb-switch ${C?"is-disabled":""}`,children:[R.jsx("input",{type:"checkbox",checked:_,disabled:C,onChange:W=>F(W.target.checked)}),R.jsx("span",{className:"eb-switch-track","aria-hidden":"true"})]})]})]})}function Vt(){const y=Ot();let u="Подключено";return y===Nt.Connecting?u="Подключение…":y===Nt.Reconnecting?u="Переподключение…":y===Nt.Disconnected&&(u="Отключено"),R.jsx("div",{className:"eb-conn-badge",style:{position:"absolute",top:10,left:10,zIndex:20,padding:"6px 10px",borderRadius:999,background:"rgba(0,0,0,0.45)",border:"1px solid rgba(255,255,255,0.12)",fontSize:12,color:"#fff",backdropFilter:"blur(6px)"},children:u})}function Xt(){const y=wt(),{isMicrophoneEnabled:u}=xt(),_=f.useRef(!1);return f.useEffect(()=>{y&&(_.current||u&&(_.current=!0,y.localParticipant.setMicrophoneEnabled(!0,{deviceId:"default"}).catch(F=>console.warn("[DefaultMicrophoneSetter] Failed to set default microphone",F))))},[y,u]),null}function Zt({localUserId:y}){const u=wt(),{localParticipant:_,microphoneTrack:F,cameraTrack:C}=xt(),[z,W]=f.useState(null),X=f.useRef(null),[B,j]=f.useState(null),L=f.useRef(null),K=f.useRef(null),I=f.useRef(new Map),J=f.useRef(new Map),tt=f.useRef(0),Z=f.useRef(!1),et=f.useRef(!1),M=f.useRef(0),Y=f.useRef({at:0,rtt:null}),[w,O]=f.useState(()=>dt("lk-debug-ping","lkDebugPing")),nt=f.useRef({at:0,lastLocalRtt:null,lastSignalRtt:null}),A=(...m)=>{w&&console.log("[Ping]",...m)};f.useEffect(()=>{const m=window.setInterval(()=>{const a=dt("lk-debug-ping","lkDebugPing");O(c=>c===a?c:a)},1e3);return()=>window.clearInterval(m)},[]),f.useEffect(()=>{if(w){A("debug enabled",{localStorage:(()=>{try{return window.localStorage.getItem("lk-debug-ping")}catch{return"(unavailable)"}})(),query:(()=>{try{return new URLSearchParams(window.location.search).get("lkDebugPing")}catch{return"(unavailable)"}})(),localIdentity:_?.identity??null});try{const a=performance?.getEntriesByType?.("resource")?.map(c=>c.name).find(c=>c.includes("/assets/CallOverlay-"))??null;a&&A("asset",a)}catch{}}},[w,_?.identity]),f.useEffect(()=>{L.current=B,K.current?.(),w&&A("localPlayoutMs state",B)},[B]),f.useEffect(()=>{if(!u)return;const m=h=>{let e=null;try{h.forEach(i=>{if(i?.type!=="inbound-rtp")return;const p=(i?.kind||i?.mediaType||"").toString().toLowerCase();if(p&&p!=="audio")return;const d=typeof i?.jitterBufferTargetDelay=="number"?i.jitterBufferTargetDelay:null;if(typeof d=="number"&&Number.isFinite(d)&&d>0){const s=d*1e3;Number.isFinite(s)&&s>0&&s<5e3&&(e=e===null?s:Math.max(e,s))}const x=typeof i?.jitterBufferDelay=="number"?i.jitterBufferDelay:null,o=typeof i?.jitterBufferEmittedCount=="number"?i.jitterBufferEmittedCount:null;if(typeof x=="number"&&typeof o=="number"&&Number.isFinite(x)&&Number.isFinite(o)&&x>0&&o>=50){const s=x/o*1e3;Number.isFinite(s)&&s>0&&s<5e3&&(e=e===null?s:Math.max(e,s))}})}catch{}return e};let a=!1;const c=async()=>{try{const e=u.engine?.pcManager?.subscriber;if(e?.getStats){const i=await e.getStats(),p=m(i);a||j(p),w&&A("playout sample",{ms:p});return}}catch(h){w&&A("playout sample failed",h)}a||j(null)},v=window.setInterval(c,2e3);return c(),()=>{a=!0,window.clearInterval(v)}},[u,w]);const rt=m=>m.getAttribute("data-lk-local-participant")==="true"?!0:m.dataset?.lkLocalParticipant==="true",l=m=>{const a=m.querySelector("[data-lk-participant-name]")||m.querySelector(".lk-participant-name"),c=a?.getAttribute("data-lk-participant-name"),v=c&&c.trim()||(a?.textContent?.trim()??"");return v?v.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null};return f.useEffect(()=>{if(!u||!_)return;const m=h=>{try{let e=null;const i=o=>{const s=(typeof o?.currentRoundTripTime=="number"?o.currentRoundTripTime:null)??(typeof o?.roundTripTime=="number"?o.roundTripTime:null)??(typeof o?.totalRoundTripTime=="number"&&Number.isFinite(o.totalRoundTripTime)&&o.totalRoundTripTime>0&&typeof o?.responsesReceived=="number"&&Number.isFinite(o.responsesReceived)&&o.responsesReceived>0?o.totalRoundTripTime/o.responsesReceived:null);return typeof s!="number"||!Number.isFinite(s)||s<=0?null:s};let p=null,d=null;h.forEach(o=>{o?.type==="transport"&&o.selectedCandidatePairId&&(p=String(o.selectedCandidatePairId))}),p&&(d=h.get?.(p)??(()=>{let o=null;return h.forEach(s=>{o||s?.id===p&&(o=s)}),o})()??null),d||h.forEach(o=>{d||o?.type==="candidate-pair"&&(o.selected||o.nominated||o.state==="succeeded")&&(d=o)});const x=d?i(d):null;if(typeof x=="number"&&Number.isFinite(x)&&x>0&&(e=x),h.forEach(o=>{if(o?.type!=="candidate-pair"||!(o.selected||o.nominated||o.state==="succeeded"))return;const s=i(o);typeof s=="number"&&(e===null||s<e)&&(e=s)}),h.forEach(o=>{if(o?.type!=="remote-inbound-rtp")return;const s=(typeof o?.roundTripTime=="number"?o.roundTripTime:null)??(typeof o?.totalRoundTripTime=="number"&&Number.isFinite(o.totalRoundTripTime)&&o.totalRoundTripTime>0&&typeof o?.roundTripTimeMeasurements=="number"&&Number.isFinite(o.roundTripTimeMeasurements)&&o.roundTripTimeMeasurements>0?o.totalRoundTripTime/o.roundTripTimeMeasurements:null);typeof s!="number"||!Number.isFinite(s)||s<=0||(e===null||s<e)&&(e=s)}),h.forEach(o=>{const s=typeof o?.roundTripTime=="number"?o.roundTripTime:null;typeof s!="number"||!Number.isFinite(s)||s<=0||(e===null||s<e)&&(e=s)}),typeof e=="number"&&Number.isFinite(e)&&e>0)return e*1e3}catch{}return null},a=async()=>{try{const h=u.engine,e=h?.client?.rtt;if((!e||e<=0)&&typeof h?.client?.sendPing=="function"){const n=Date.now();if(n-M.current>5e3){M.current=n;try{await h.client.sendPing(),w&&A("signal sendPing() called")}catch(k){w&&A("signal sendPing() failed",k)}}}if(w){const n=Date.now(),k=nt.current;(typeof e=="number"?e:null)!==k.lastSignalRtt&&n-k.at>750&&(nt.current={...k,at:n,lastSignalRtt:typeof e=="number"?e:null},A("signal rtt",{rtt:e,hasEngine:!!h,localIdentity:_.identity}))}if(typeof e=="number"&&Number.isFinite(e)&&e>0){W(e),w&&A("local rtt set",{ms:Math.round(e),source:"engine.client.rtt"});return}const i=F?.track;if(i&&typeof i.getSenderStats=="function")try{const n=await i.getSenderStats(),k=typeof n?.roundTripTime=="number"?n.roundTripTime:null;if(typeof k=="number"&&Number.isFinite(k)&&k>0){const g=k*1e3;W(g),w&&A("local rtt set",{ms:Math.round(g),source:"LocalAudioTrack.getSenderStats().roundTripTime"});return}}catch(n){w&&A("mic getSenderStats failed",n)}const p=C?.track;if(p&&typeof p.getSenderStats=="function")try{const n=await p.getSenderStats(),g=(Array.isArray(n)?n:[]).map(t=>typeof t?.roundTripTime=="number"?t.roundTripTime:null).filter(t=>typeof t=="number"&&Number.isFinite(t)&&t>0);if(g.length>0){const b=Math.min(...g)*1e3;W(b),w&&A("local rtt set",{ms:Math.round(b),source:"LocalVideoTrack.getSenderStats()[].roundTripTime"});return}}catch(n){w&&A("camera getSenderStats failed",n)}const d=Date.now();if(d-tt.current<3e3)return;const x=h?.pcManager?.publisher,o=h?.pcManager?.subscriber,s=[x,o].filter(Boolean),T=[F?.track,C?.track].filter(Boolean);if(s.length>0||T.length>0)tt.current=d;else{w&&!et.current&&(et.current=!0,A("waiting for transports/tracks",{publisher:!!x,subscriber:!!o,trackCandidates:T.length}));return}for(const n of s){if(!n?.getStats)continue;const k=await n.getStats(),g=m(k);if(typeof g=="number"&&Number.isFinite(g)&&g>0){W(g),w&&A("local rtt set",{ms:Math.round(g),source:"pcTransport.getStats()"});return}}for(const n of T){if(!n?.getRTCStatsReport)continue;const k=await n.getRTCStatsReport();if(!k)continue;const g=m(k);if(typeof g=="number"&&Number.isFinite(g)&&g>0){W(g),w&&A("local rtt set",{ms:Math.round(g),source:"MediaStreamTrack.getRTCStatsReport()"});return}}Z.current||(Z.current=!0,w&&A("could not compute local rtt",{signalRtt:e,transports:s.length,trackCandidates:T.length,localIdentity:_.identity}))}catch(h){w&&A("updateRtt error",h)}},c=setInterval(()=>void a(),1500);a();const v=setTimeout(()=>void a(),2500);return()=>{clearInterval(c),clearTimeout(v)}},[u,_,F?.trackSid,C?.trackSid]),f.useEffect(()=>{if(!u||!_)return;const m=new TextEncoder,a=async()=>{try{const e=X.current;if(typeof e!="number"||!Number.isFinite(e)||e<=0){w&&A("skip publish eb.ping (no local rtt yet)",{localRtt:e});return}const i=Date.now(),p=Y.current,d=p.rtt===null||Math.abs(p.rtt-e)>=2;if(!(i-p.at>=2e3)&&!d)return;Y.current={at:i,rtt:e};const o=L.current,s={t:"eb.ping",v:2,rtt:Math.round(e),playoutMs:typeof o=="number"&&Number.isFinite(o)&&o>=0?Math.round(o):0,ts:i};await _.publishData(m.encode(JSON.stringify(s)),{reliable:!1,topic:"eb.ping"}),w&&A("publish eb.ping ok",s)}catch(e){w&&A("publish eb.ping failed",e),w&&!window.__ebPingPublishWarned&&(window.__ebPingPublishWarned=!0,console.warn("[Ping] Failed to publish eb.ping (data channel). Check LiveKit token grant canPublishData=true."))}},c=new TextDecoder,v=(e,i,p,d)=>{if(d&&d!=="eb.ping")return;const x=i?.identity;if(x&&!(_&&x===_.identity))try{const o=JSON.parse(c.decode(e));if(!o||o.t!=="eb.ping")return;const s=Number(o.rtt);if(!Number.isFinite(s)||s<=0)return;const T=Number(o.playoutMs),n=Number.isFinite(T)&&T>=0?T:0,k=typeof i?.name=="string"&&i.name?i.name:null,g=I.current.get(x);I.current.set(x,s),k&&I.current.set(k,s),J.current.set(x,n),k&&J.current.set(k,n);const t=typeof i?.metadata=="string"?i.metadata:null;if(t)try{const b=JSON.parse(t);b?.displayName&&I.current.set(String(b.displayName),s),b?.userId&&I.current.set(String(b.userId),s),b?.displayName&&J.current.set(String(b.displayName),n),b?.userId&&J.current.set(String(b.userId),n)}catch{}w&&(g===void 0||Math.abs(g-s)>=2)&&A("recv eb.ping",{from:x,name:k,rtt:s,playoutMs:n,ts:o.ts,topic:d??null}),K.current?.()}catch{}};u.on(kt.DataReceived,v);const h=setInterval(()=>void a(),2e3);return a(),()=>{clearInterval(h),u.off(kt.DataReceived,v)}},[u,_,w]),f.useEffect(()=>{X.current=z,K.current?.(),w&&A("localRtt state",z)},[z]),f.useEffect(()=>{if(!u)return;const m=document.querySelector(".call-container");if(!m)return;const a=i=>{const p=X.current;return typeof p!="number"||!Number.isFinite(p)||p<=0?"—":i?`${Math.round(p)} мс`:"—"},c=()=>{const i=m.querySelectorAll(".lk-participant-metadata-item[data-lk-quality]");w&&A("dom scan",{indicators:i.length}),i.forEach(p=>{const d=p.closest(".lk-participant-tile, [data-participant]");if(!d)return;const x=rt(d),o=l(d);p.classList.contains("eb-ping-display")||p.classList.add("eb-ping-display");let s=p.querySelector(".eb-ping-text");s||(s=document.createElement("span"),s.className="eb-ping-text",p.appendChild(s));let T=null,n=a(x);if(x){const t=X.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&(T=Math.round(t),n=`${T} мс`)}else{const t=(o?I.current.get(o):void 0)??void 0,b=(o?J.current.get(o):void 0)??0,U=X.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&typeof U=="number"&&U>0&&(T=Math.round((t+U)/2+(typeof b=="number"&&Number.isFinite(b)&&b>=0?b:0)),n=`${T} мс`)}const k=typeof T=="number"&&Number.isFinite(T)&&T>0;if(p.classList.toggle("eb-ping-has-value",k),typeof T=="number"&&Number.isFinite(T)&&T>0){const t=T<=200?"good":T<=500?"warn":"bad";p.setAttribute("data-eb-ping-level",t)}else p.removeAttribute("data-eb-ping-level");const g=k?n:"";if(s.textContent!==g&&(s.textContent=g,w)){const t=X.current,b=o?I.current.get(o):void 0;A("dom set",{name:o,isLocal:x,text:g,mine:t,remote:b})}})};let v=!1;const h=()=>{v||(v=!0,requestAnimationFrame(()=>{v=!1,c()}))};K.current=h;const e=new MutationObserver(()=>h());return e.observe(m,{childList:!0,subtree:!0}),h(),()=>{K.current===h&&(K.current=null),e.disconnect()}},[u,_,y,w]),null}function Jt(){const y=wt(),u=f.useRef(null),_=f.useRef(new Map),F=f.useRef(0),C=f.useRef(new WeakMap),z=f.useRef(new Map),W=l=>l.getAttribute("data-lk-local-participant")==="true"?!0:l.dataset?.lkLocalParticipant==="true",X=l=>{const m=l.querySelector("[data-lk-participant-name]")||l.querySelector(".lk-participant-name"),a=m?.getAttribute("data-lk-participant-name"),c=a&&a.trim()||(m?.textContent?.trim()??"");return c?c.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null},B=l=>{const m=l.getAttribute("data-lk-participant-identity")||l.getAttribute("data-participant-identity")||l.getAttribute("data-user-id")||l.dataset?.lkParticipantIdentity||"",a=String(m||"").trim();if(a)return a;const c=l.getAttribute("data-lk-participant-metadata")||(l.dataset?l.dataset.lkParticipantMetadata:"")||"";if(c)try{const v=JSON.parse(c);if(v?.userId)return String(v.userId).trim()}catch{}return null},j=l=>{const m=B(l),a=X(l),c=m||a;return c?{key:c,userId:m,name:a}:null},L=l=>{const m=_.current,a=m.get(l);if(a)return a;const c={volume:1,muted:!1,lastNonZeroPct:100};return m.set(l,c),c},K=async()=>{if(F.current=Date.now(),u.current){try{u.current.state!=="running"&&await u.current.resume()}catch{}return u.current}try{const l=new(window.AudioContext||window.webkitAudioContext);u.current=l;try{l.state!=="running"&&await l.resume()}catch{}return l}catch{return null}},I=l=>{const m=l?.metadata;if(!m||typeof m!="string")return null;try{const a=JSON.parse(m);if(!a||typeof a!="object")return null;const c=a.userId?String(a.userId):void 0,v=a.displayName?String(a.displayName):void 0;return{userId:c,displayName:v}}catch{return null}},J=l=>{if(!y)return null;const m=(l.userId?y.remoteParticipants.get(l.userId):null)||y.remoteParticipants.get(l.key)||null;if(m)return m;const a=(l.name||"").trim(),c=(l.key||"").trim(),v=(l.userId||"").trim();for(const h of y.remoteParticipants.values())try{if(v&&String(h.identity)===v||c&&String(h.identity)===c||a&&String(h.name||"").trim()===a)return h;const e=I(h);if(v&&e?.userId&&e.userId===v||a&&e?.displayName&&e.displayName.trim()===a)return h}catch{}return null},tt=async(l,m)=>{if(!y)return;const{key:a}=l,c=J(l);if(!c)return;const v=L(a),h=v.muted?0:v.volume,e=h>1,i=u.current||(e&&m?await K():null),p=[];try{const d=c.trackPublications;if(d?.values)for(const x of d.values())p.push(x)}catch{}for(const d of p){if(d?.kind!==_t.Kind.Audio)continue;if(typeof d?.setEnabled=="function")try{d.setEnabled(!v.muted&&h>0)}catch{}const x=d?.track;if(!(x instanceof Wt))continue;if(i){const s=C.current.get(x);(!s||s.ctx!==i||!s.inited)&&(x.setAudioContext(i),C.current.set(x,{ctx:i,inited:!0}))}const o=v.muted?0:Math.max(0,Math.min(1.5,h));x.setVolume(o)}};f.useEffect(()=>{if(!y)return;const l=(m,a,c)=>{try{const v=String(c?.identity||""),h=String(c?.name||""),e=v||h;if(!e||c?.isLocal)return;_.current.has(e)&&m?.kind===_t.Kind.Audio&&tt({key:e,userId:v||null,name:h||null},!1)}catch{}};return y.on(kt.TrackSubscribed,l),()=>{y.off(kt.TrackSubscribed,l)}},[y]);const Z=150,et=100,M=105,Y=2*Math.PI*M,w=l=>Math.max(0,Math.min(Z,Math.round(l))),O=l=>w(l.muted?0:l.volume*100),nt=(l,m,a)=>{const c=Math.max(0,Y-a);l.style.strokeDasharray=`${a} ${c}`,l.style.strokeDashoffset=`-${m}`,l.style.opacity=a>0?"1":"0"},A=(l,m,a)=>{const c=l.__ebRingSafe,v=l.__ebRingOver,h=l.__ebRingThumb,e=l.__ebRingLabel,i=l.__ebRingVal,p=l.__ebRingMuteBtn;if(!c||!v)return;const d=w(m),x=Math.min(d,et)/Z,o=Math.max(d-et,0)/Z,s=Y*x,T=Y*o;if(nt(c,0,s),nt(v,s,T),h){const k=d/Z*(Math.PI*2),g=110+M*Math.cos(k),t=110+M*Math.sin(k);h.setAttribute("cx",`${g}`),h.setAttribute("cy",`${t}`),h.style.opacity="1"}i?i.textContent=`${d}%`:e&&(e.textContent=`${d}%`),p&&(p.textContent=a||d===0?"Вернуть":"Заглушить"),l.setAttribute("data-eb-over",d>et?"true":"false"),l.setAttribute("data-eb-muted",a||d===0?"true":"false")},rt=(l,m)=>{const a=m.getBoundingClientRect(),c=a.left+a.width/2,v=a.top+a.height/2,h=l.clientX-c,e=l.clientY-v;let i=Math.atan2(e,h)*180/Math.PI;i=(i+90+360)%360;const p=i/360;return w(p*Z)};return f.useEffect(()=>{if(!y)return;const l=document.body;if(!l)return;const m=()=>{try{l.querySelectorAll(".call-container .lk-participant-tile").forEach(e=>{if(W(e))return;const i=j(e);if(!i)return;e.setAttribute("data-eb-remote","true");const p=J(i),d=p?String(p.identity):i.key,o=(p?I(p):null)?.displayName||i.name||null,s={key:d,userId:d,name:o};e.setAttribute("data-eb-vol-key",d);const T=e.getAttribute("data-video-muted")==="true"||e.getAttribute("data-lk-video-muted")==="true"||e.dataset?.videoMuted==="true"||e.dataset?.lkVideoMuted==="true",n=e.querySelector("video.lk-participant-media-video")||e.querySelector("video");if(!!(!T&&n&&n.offsetWidth>0&&n.offsetHeight>0)){e.querySelectorAll(".eb-vol-ring").forEach(r=>r.remove());return}const g=e.querySelector(".lk-participant-placeholder");if(!g)return;e.style.position||(e.style.position="relative");let t=e.querySelector(".eb-vol-ring");if(t?t.setAttribute("data-eb-vol-key",d):(t=document.createElement("div"),t.className="eb-vol-ring",t.setAttribute("data-eb-vol-key",d),t.innerHTML=`
              <svg class="eb-vol-ring-svg" width="220" height="220" viewBox="0 0 220 220" aria-hidden="true" style="transform: rotate(-90deg)">
                <circle class="bg" cx="110" cy="110" r="105" />
                <circle class="safe" cx="110" cy="110" r="105" />
                <circle class="over" cx="110" cy="110" r="105" />
                <circle class="thumb" cx="110" cy="5" r="7" />
                <circle class="hit" cx="110" cy="110" r="105" />
              </svg>
              <div class="center" aria-hidden="true">
                <div class="label"><span class="prefix">громкость: </span><span class="val">100%</span></div>
                <div class="actions">
                  <button type="button" class="btn mute">Заглушить</button>
                  <button type="button" class="btn reset">100%</button>
                </div>
              </div>
            `,e.appendChild(t)),!t.__ebRingInit){t.__ebRingInit=!0;const r=t.querySelector("svg.eb-vol-ring-svg"),S=t.querySelector("circle.safe"),P=t.querySelector("circle.over"),Q=t.querySelector("circle.thumb"),D=t.querySelector("circle.hit"),V=t.querySelector(".label"),G=t.querySelector(".label .val"),N=t.querySelector("button.btn.mute"),E=t.querySelector("button.btn.reset");t.__ebRingSvg=r,t.__ebRingSafe=S,t.__ebRingOver=P,t.__ebRingThumb=Q,t.__ebRingHit=D,t.__ebRingLabel=V,t.__ebRingVal=G,t.__ebRingMuteBtn=N,t.__ebRingResetBtn=E}const b=()=>{const r=L(d),S=O(r);S>0&&(r.lastNonZeroPct=S),A(t,S,!!r.muted)};try{const r=e.getBoundingClientRect(),S=e.offsetWidth||r.width||1,P=e.offsetHeight||r.height||1,Q=r.width?r.width/S:1,D=r.height?r.height/P:1,V=g.getBoundingClientRect(),N=g.querySelector("img.eb-ph")?.getBoundingClientRect(),E=N&&N.width>10?N.width:V.width*.8,q=(Q+D)/2||1,ot=E/q,lt=N&&N.width>10?N.left-r.left+N.width/2:V.left-r.left+V.width/2,ct=N&&N.height>10?N.top-r.top+N.height/2:V.top-r.top+V.height/2,St=lt/Q-e.clientLeft,pt=ct/D-e.clientTop,gt=220,ft=105-10/2,ut=0,H=ot/2,bt=gt*(H+ut)/ft,Rt=Math.min(Math.min(e.clientWidth||S,e.clientHeight||P)-6,bt),it=Math.max(56,Rt);it<150?t.setAttribute("data-eb-compact","true"):t.removeAttribute("data-eb-compact"),t.style.width=`${it}px`,t.style.height=`${it}px`,t.style.left=`${St}px`,t.style.top=`${pt}px`,t.style.transform="translate(-50%, -50%)"}catch{}const U=(r,S)=>{let P=w(r);const Q=String(t?.getAttribute("data-eb-vol-key")||d).trim();if(!Q)return;const D=typeof t.__ebLastPct=="number"?t.__ebLastPct:P;if(t.__ebDragging){const G=P-D;Math.abs(G)>Z/2&&(P=D>Z/2?Z:0)}t.__ebLastPct=P;const V=L(Q);P===0?(V.muted=!0,V.volume=0):(V.muted=!1,V.lastNonZeroPct=P,V.volume=P/100),A(t,P,!!V.muted),tt({key:Q,userId:Q,name:null},S)};if(!t.__ebRingBound){t.__ebRingBound=!0;const r=t.__ebRingSvg,S=t.__ebRingHit,P=t.__ebRingMuteBtn,Q=t.__ebRingResetBtn;if(r&&S){S.addEventListener("pointerdown",N=>{N.preventDefault(),N.stopPropagation(),F.current=Date.now(),t.__ebDragging=!0;try{const q=String(t?.getAttribute("data-eb-vol-key")||"").trim();q&&(t.__ebLastPct=O(L(q)))}catch{}try{S.setPointerCapture?.(N.pointerId)}catch{}const E=rt(N,r);U(E,!0)}),S.addEventListener("pointermove",N=>{if(!t.__ebDragging)return;N.preventDefault(),N.stopPropagation();const E=rt(N,r);U(E,!0)});const G=N=>{t.__ebDragging&&(t.__ebDragging=!1);try{S.releasePointerCapture?.(N.pointerId)}catch{}};S.addEventListener("pointerup",G),S.addEventListener("pointercancel",G)}const D=G=>{G.preventDefault(),G.stopPropagation();const N=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!N)return;const E=L(N),q=O(E);if(E.muted||q===0){const lt=w(E.lastNonZeroPct||100);E.muted=!1,E.lastNonZeroPct=Math.max(1,lt),E.volume=E.lastNonZeroPct/100}else q>0&&(E.lastNonZeroPct=q),E.muted=!0,E.volume=0;const ot=O(E);t.__ebLastPct=ot,A(t,ot,!!E.muted),tt({key:N,userId:N,name:null},!0)},V=G=>{G.preventDefault(),G.stopPropagation();const N=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!N)return;const E=L(N);E.muted=!1,E.lastNonZeroPct=100,E.volume=1;const q=O(E);t.__ebLastPct=q,A(t,q,!!E.muted),tt({key:N,userId:N,name:null},!0)};P?.addEventListener("click",D),Q?.addEventListener("click",V)}e.__ebVolWheelBound||(e.__ebVolWheelBound=!0,e.addEventListener("wheel",r=>{r.preventDefault(),r.stopPropagation();const S=String(e.getAttribute("data-eb-vol-key")||"").trim();if(!S)return;const P=L(S),Q=O(P),D=(r.deltaMode===1?r.deltaY*40:r.deltaMode===2?r.deltaY*(window.innerHeight||800):r.deltaY)||0,V=z.current,N=(V.get(S)||0)+D;V.set(S,N);const E=100,q=Math.trunc(Math.abs(N)/E);if(q<=0)return;const ot=q*E*Math.sign(N);V.set(S,N-ot);const lt=r.shiftKey?2:1,ct=N<0?1:-1;U(Q+ct*q*lt,!0)},{passive:!1})),b(),tt(s,!1)})}catch{}};let a=!1;const c=()=>{a||(a=!0,requestAnimationFrame(()=>{a=!1,m()}))},v=new MutationObserver(()=>c());return v.observe(l,{childList:!0,subtree:!0}),m(),()=>{v.disconnect()}},[y]),null}function Yt(){const y=wt(),{isMicrophoneEnabled:u,microphoneTrack:_}=xt(),F=Ut(),[C,z]=f.useState(()=>yt(at.aec,!0)),[W,X]=f.useState(()=>yt(at.ns,!0)),[B,j]=f.useState(()=>yt(at.agc,!0)),[L,K]=f.useState(()=>yt(at.krisp,!1)),[I,J]=f.useState("checking"),[tt,Z]=f.useState("Проверяем поддержку Krisp…");f.useEffect(()=>{let M=!0;async function Y(){try{const w=await Mt(()=>import("./index-Cc9ouniY.js"),[]),O=typeof w.isKrispNoiseFilterSupported=="function"?w.isKrispNoiseFilterSupported():!1;if(!M)return;J(O?"supported":"unsupported"),Z(O?"Браузер поддерживает Krisp.":"Этот браузер не поддерживает Krisp.")}catch{if(!M)return;J("error"),Z("Не удалось проверить поддержку Krisp (ошибка загрузки модуля).")}}return Y(),()=>{M=!1}},[]);const et=f.useRef("");return f.useEffect(()=>{if(!y||!u)return;const M=`${C}|${W}|${B}|${_?.trackSid??""}`;et.current!==M&&(et.current=M,y.localParticipant.setMicrophoneEnabled(!0,{echoCancellation:C,noiseSuppression:W,autoGainControl:B}).catch(Y=>console.warn("[CallSettings] Failed to apply mic capture options",Y)))},[y,u,C,W,B,_?.trackSid]),f.useEffect(()=>{u&&I==="supported"&&(F.isNoiseFilterPending||L!==F.isNoiseFilterEnabled&&F.setNoiseFilterEnabled(L).catch(M=>{console.warn("[CallSettings] Krisp setNoiseFilterEnabled failed, disabling toggle",M),K(!1),mt(at.krisp,!1),J("error"),Z("Krisp недоступен (ошибка подключения к сервису шумоподавления).")}))},[u,_?.trackSid,L,F.isNoiseFilterPending,F.isNoiseFilterEnabled,I]),f.useEffect(()=>{const M=()=>{const O=document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li"),nt=[],A=new Map;O.forEach(l=>{const m=l.querySelector(".lk-button");if(!m)return;const a=m.textContent||"",c=/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i.test(a);let v=a.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim();v=v.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),A.has(v)||A.set(v,[]),A.get(v).push(l),c&&nt.push(l)}),nt.forEach(l=>{l.remove()}),document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button").forEach(l=>{const m=Array.from(l.childNodes).find(c=>c.nodeType===Node.TEXT_NODE);let a=l.querySelector("span.eb-device-label");if(m&&!a){const c=m.textContent||"";a=document.createElement("span"),a.className="eb-device-label",a.textContent=c,l.replaceChild(a,m)}if(a){let c=a.textContent||"";c=c.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim(),c=c.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),c=c.replace(/\s*\([0-9a-fA-F]{4}:\s*$/,"").trim(),c!==a.textContent&&(a.textContent=c),setTimeout(()=>{const v=l.getBoundingClientRect(),h=a.getBoundingClientRect(),i=v.width-24;if(h.width>i){const p=h.width-i;a.setAttribute("data-overflows","true"),a.style.setProperty("--eb-device-scroll-distance",`${-p}px`)}else a.removeAttribute("data-overflows"),a.style.removeProperty("--eb-device-scroll-distance")},10)}})};M();const Y=new MutationObserver(()=>{setTimeout(M,50)}),w=document.querySelector(".call-container .lk-settings-menu-modal");if(w)return Y.observe(w,{childList:!0,subtree:!0,characterData:!0}),()=>Y.disconnect()},[]),R.jsxs("div",{className:"eb-call-settings",style:{width:"100%"},children:[R.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12},children:[R.jsx("div",{style:{fontSize:18,fontWeight:600},children:"Настройки"}),R.jsx("button",{type:"button",className:"btn btn-icon btn-ghost","aria-label":"Закрыть настройки",title:"Закрыть настройки",onClick:M=>{M.preventDefault(),M.stopPropagation();const Y=document.querySelector(".call-container .lk-settings-toggle");if(Y){Y.click();return}const w=document.querySelector(".call-container .lk-settings-menu-modal");w&&(w.style.display="none")},style:{padding:8},children:R.jsx(Ht,{size:18})})]}),R.jsxs("div",{className:"eb-settings-section",children:[R.jsx("div",{className:"eb-section-title",children:"Обработка микрофона"}),R.jsx(vt,{label:"WebRTC: AEC (анти-эхо)",description:"Эхо‑подавление на уровне браузера (лучше включать почти всегда).",checked:C,onChange:M=>{z(M),mt(at.aec,M)}}),R.jsx(vt,{label:"WebRTC: NS (шумоподавление)",description:"Шумоподавление на уровне браузера.",checked:W,onChange:M=>{X(M),mt(at.ns,M)}}),R.jsx(vt,{label:"WebRTC: AGC (автогейн)",description:"Автоматическая регулировка усиления микрофона.",checked:B,onChange:M=>{j(M),mt(at.agc,M)}}),R.jsx(vt,{label:"Krisp (улучшенное шумоподавление)",description:`${tt} Может быть недоступен на self-hosted LiveKit.`,checked:L,disabled:!u||F.isNoiseFilterPending||I==="unsupported"||I==="error",rightHint:u?I==="checking"?"Проверяем…":I==="unsupported"?"Не поддерживается":I==="error"?"Ошибка проверки":F.isNoiseFilterPending?"Применяем…":L&&!F.isNoiseFilterEnabled?"Не активно":F.isNoiseFilterEnabled?"Активно":"":"Включите микрофон",onChange:M=>{K(M),mt(at.krisp,M)}}),R.jsx("div",{className:"eb-settings-note",children:"Изменения AEC/NS/AGC применяются перезапуском микрофона и могут дать короткий “пик” при переключении."})]}),R.jsxs("div",{className:"eb-settings-grid",style:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))",gap:16,alignItems:"start",marginBottom:12},children:[R.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[R.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Микрофон"}),R.jsx(Ct,{kind:"audioinput",requestPermissions:!0})]}),R.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[R.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Камера"}),R.jsx(Ct,{kind:"videoinput",requestPermissions:!0})]}),R.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[R.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Вывод звука"}),R.jsx(Ct,{kind:"audiooutput",requestPermissions:!0}),R.jsx("div",{style:{fontSize:11,opacity:.65,marginTop:6},children:"На Safari/iOS переключение устройства вывода может быть недоступно."})]})]}),R.jsx("div",{style:{fontSize:12,opacity:.8},children:"Выберите устройства ввода. Закрыть это окно можно кнопкой «Настройки» внизу."})]})}function ae({open:y,conversationId:u,onClose:_,onMinimize:F,minimized:C=!1,initialVideo:z=!1,initialAudio:W=!0,peerAvatarUrl:X=null,avatarsByName:B={},avatarsById:j={},localUserId:L=null,isGroup:K=!1}){const[I,J]=f.useState(null),[tt,Z]=f.useState(null),[et,M]=f.useState(!W),[Y,w]=f.useState(!!z),[O,nt]=f.useState(()=>typeof window<"u"?window.innerWidth>768:!0),[A,rt]=f.useState(!1),l=Lt(i=>i.session?.user),m=f.useRef(!1),a=f.useRef(!1),c=f.useMemo(()=>l?.avatarUrl??null,[l?.avatarUrl]),v=f.useCallback(i=>{if(m.current||(m.current=!0),i?.manual&&(a.current=!0),u&&K){try{Dt(u)}catch(d){console.error("Error leaving call room:",d)}try{Et([u])}catch(d){console.error("Error requesting call status update:",d)}}const p=a.current?{...i??{},manual:!0}:i;_(p)},[u,K,_]),h=`
    /* Force videos to fit tile without cropping on all layouts */
    .call-container video { object-fit: contain !important; object-position: center !important; background: #000 !important; }
    .call-container .lk-participant-tile video,
    .call-container .lk-participant-media video,
    .call-container .lk-video-tile video,
    .call-container .lk-stage video,
    .call-container .lk-grid-stage video { object-fit: contain !important; object-position: center !important; background: #000 !important; }

    /* Focus layout: some browsers/layouts end up placing the <video> element at the top (auto height).
       Make the media area a flex box and center the video element itself. */
    .call-container .lk-participant-tile .lk-participant-media{
      display:flex !important;
      align-items:center !important;
      justify-content:center !important;
      min-height:0 !important;
      flex: 1 1 auto !important;
    }
    .call-container .lk-participant-tile .lk-participant-media-video,
    .call-container .lk-participant-tile video.lk-participant-media-video,
    .call-container .lk-participant-tile .lk-participant-media video{
      width: 100% !important;
      height: auto !important;
      max-height: 100% !important;
      object-fit: contain !important;
      object-position: center !important;
      background: #000 !important;
      display:block !important;
    }
    
    /* Ensure placeholder stays circular and doesn't stretch */
    .call-container .lk-participant-placeholder {
      aspect-ratio: 1 !important;
      border-radius: 50% !important;
      margin: auto !important;
      align-self: center !important;
      flex-shrink: 0 !important;
      /* IMPORTANT: don't override LiveKit's absolute positioning here; it can break video layout */
    }
    
    /* Light semi-transparent border for participant tiles */
    .call-container .lk-participant-tile {
      background: #000 !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 8px !important;
      overflow: hidden !important;
    }

    /* When a tile is stretched tall (focus layout) but its media element is auto-height,
       the media ends up top-aligned. Center the flex column ONLY for tiles that currently show video. */
    .call-container .lk-participant-tile[data-eb-has-video="true"]{
      justify-content: center !important;
    }
    
    /* Hide chat entry point in the control bar (we expose device selection via Settings and also via button group menus) */
    .call-container .lk-control-bar .lk-chat-toggle { display: none !important; }

    /* Mobile: make the LiveKit UI feel native fullscreen and fix control button height mismatch */
    @media (max-width: 768px){
      /* iOS safe area: keep controls above home indicator */
      .call-container .lk-control-bar{
        padding-bottom: calc(.75rem + env(safe-area-inset-bottom, 0px)) !important;
      }
      /* Unify button heights (Settings + Leave were shorter than button-groups on mobile) */
      .call-container .lk-control-bar button,
      .call-container .lk-control-bar .lk-button,
      .call-container .lk-control-bar .lk-disconnect-button,
      .call-container .lk-control-bar .lk-settings-toggle{
        min-height: 44px !important;
        padding-top: .75rem !important;
        padding-bottom: .75rem !important;
        align-items: center !important;
      }
    }

    /* Settings toggles */
    .call-container .eb-settings-section { margin-bottom: 16px; }
    .call-container .eb-section-title { font-size: 12px; color: rgba(255,255,255,0.72); margin-bottom: 10px; }
    .call-container .eb-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.18);
      border-radius: 12px;
      margin-bottom: 10px;
    }
    .call-container .eb-toggle-text { min-width: 0; }
    .call-container .eb-toggle-label { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.92); }
    .call-container .eb-toggle-desc { font-size: 11px; color: rgba(255,255,255,0.62); margin-top: 4px; line-height: 1.25; }
    .call-container .eb-toggle-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .call-container .eb-toggle-hint { font-size: 11px; color: rgba(255,255,255,0.55); max-width: 120px; text-align: right; }
    .call-container .eb-settings-note { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 6px; }

    .call-container .eb-switch { position: relative; display: inline-flex; align-items: center; }
    .call-container .eb-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .call-container .eb-switch-track {
      width: 44px;
      height: 24px;
      border-radius: 999px;
      background: rgba(255,255,255,0.14);
      border: 1px solid rgba(255,255,255,0.14);
      position: relative;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .call-container .eb-switch-track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      transition: transform 120ms ease;
    }
    .call-container .eb-switch input:checked + .eb-switch-track {
      background: rgba(217,119,6,0.55);
      border-color: rgba(217,119,6,0.55);
    }
    .call-container .eb-switch input:checked + .eb-switch-track::after { transform: translateX(20px); }
    .call-container .eb-switch.is-disabled { opacity: 0.55; pointer-events: none; }

    /* Settings modal: keep layout contained and prevent long device labels from breaking columns */
    .call-container .lk-settings-menu-modal {
      width: min(980px, calc(100vw - 32px)) !important;
      max-width: min(980px, calc(100vw - 32px)) !important;
      max-height: min(80vh, 760px) !important;
      min-height: unset !important;
      padding: 20px !important;
      background: var(--surface-200) !important;
      border: 1px solid var(--surface-border) !important;
      border-radius: 16px !important;
      overflow: hidden !important;
      box-shadow: var(--shadow-sharp) !important;
      /* Enable vertical scrolling on mobile */
      overflow-y: auto !important;
      -webkit-overflow-scrolling: touch !important;
      /* Ensure modal stays above our overlay chrome */
      z-index: 2000 !important;
    }
    
    /* Ensure settings content can scroll on mobile */
    @media (max-width: 768px) {
      .call-container .lk-settings-menu-modal {
        max-height: min(90vh, 600px) !important;
        padding: 16px !important;
      }
    }

    .call-container .lk-settings-menu-modal .eb-settings-grid {
      min-width: 0 !important;
    }

    .call-container .lk-settings-menu-modal .eb-device-col {
      min-width: 0 !important;
    }

    /* LiveKit uses white-space: nowrap for buttons globally; override inside settings to avoid overflow */
    .call-container .lk-settings-menu-modal .lk-media-device-select {
      width: 100% !important;
      max-width: 100% !important;
      overflow: hidden !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button {
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      justify-content: flex-start !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      padding-left: 12px !important;
      padding-right: 12px !important;
      position: relative !important;
      text-overflow: ellipsis !important;
    }

    /* Smooth scrolling animation for long device names - only on hover and only if overflowing */
    @keyframes eb-device-scroll {
      0%, 100% {
        transform: translateX(0);
      }
      15% {
        transform: translateX(0);
      }
      42.5% {
        transform: translateX(var(--eb-device-scroll-distance, -100px));
      }
      57.5% {
        transform: translateX(var(--eb-device-scroll-distance, -100px));
      }
      85% {
        transform: translateX(0);
      }
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button {
      display: flex !important;
      align-items: center !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button > span.eb-device-label {
      display: inline-block !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      max-width: 100% !important;
    }

    /* Enable smooth scrolling animation only on hover and only if text overflows */
    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button:hover > span.eb-device-label[data-overflows="true"] {
      overflow: visible !important;
      text-overflow: clip !important;
      max-width: none !important;
      animation: eb-device-scroll 6s ease-in-out infinite !important;
    }

    .call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button * {
      min-width: 0 !important;
    }

    /* Override LiveKit's blue accent color for selected devices with eblusha brand color */
    .call-container .lk-settings-menu-modal .lk-media-device-select [data-lk-active="true"] > .lk-button {
      color: #fff !important;
      background-color: var(--brand, #d97706) !important;
    }
    .call-container .lk-settings-menu-modal .lk-media-device-select [data-lk-active="true"] > .lk-button:hover {
      background-color: var(--brand-600, #e38b0a) !important;
    }

    /* Ping display: always keep value on one line */
    .call-container .eb-ping-display .eb-ping-text { font-size: 11px; opacity: 0.85; white-space: nowrap; }

    /* LiveKit hides connection quality until hover; keep it always visible so ping is always visible */
    .call-container .lk-participant-tile .lk-connection-quality {
      opacity: 1 !important;
      transition-delay: 0s !important;
    }

    /* When we have a ping value, fully replace the quality icon with text */
    .call-container .lk-connection-quality.eb-ping-display { width: auto !important; min-width: 1.5rem; }
    .call-container .eb-ping-display.eb-ping-has-value svg { display: none !important; }
    .call-container .eb-ping-display.eb-ping-has-value .eb-ping-text { display: inline !important; }
    .call-container .eb-ping-display:not(.eb-ping-has-value) .eb-ping-text { display: none !important; }

    /* Ping severity colors */
    .call-container .eb-ping-display[data-eb-ping-level="good"] .eb-ping-text { color: #22c55e; } /* green */
    .call-container .eb-ping-display[data-eb-ping-level="warn"] .eb-ping-text { color: #fbbf24; } /* yellow */
    .call-container .eb-ping-display[data-eb-ping-level="bad"] .eb-ping-text { color: #ef4444; }  /* red */

    /* Avoid metadata overflow (ping text should not leave tile) */
    .call-container .lk-participant-metadata { box-sizing: border-box; max-width: 100%; }
    .call-container .lk-connection-quality.eb-ping-display { max-width: 72px; overflow: hidden; }
    .call-container .eb-ping-display .eb-ping-text {
      display: inline-block;
      max-width: 72px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Per-participant volume: modern volume ring around avatar (0..150%, red after 100) */
    .call-container .eb-vol-ring{
      position:absolute;
      display:block;
      pointer-events:none;
      opacity:0;
      transition: opacity 520ms cubic-bezier(.2,.8,.2,1);
      transition-delay: 200ms;
      touch-action:none;
      -webkit-tap-highlight-color: transparent;
      user-select:none;
      z-index: 6;
    }
    /* Match LiveKit spotlight button rules: appears on hover/focus */
    .call-container .lk-participant-tile:hover .eb-vol-ring,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring{
      opacity:1;
      pointer-events:auto;
      transition-delay: 0ms;
    }
    .call-container .eb-vol-ring-svg{
      width:100%;
      height:100%;
      display:block;
    }
    .call-container .eb-vol-ring-svg circle{
      fill:none;
      stroke-width:10;
    }
    .call-container .eb-vol-ring-svg .bg{
      stroke: rgba(255,255,255,0.12);
    }
    .call-container .eb-vol-ring-svg .safe{
      stroke:#d97706;
      stroke-linecap:round;
      opacity:0;
    }
    .call-container .eb-vol-ring-svg .over{
      stroke:#ef4444;
      stroke-linecap:round;
      opacity:0;
    }
    .call-container .eb-vol-ring-svg .thumb{
      fill: rgba(255,255,255,.92);
      stroke: rgba(0,0,0,.25);
      stroke-width:1;
      filter: drop-shadow(0 8px 18px rgba(0,0,0,.35));
      opacity:0;
    }
    .call-container .lk-participant-tile:hover .eb-vol-ring-svg .thumb,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring-svg .thumb{ opacity:1; }
    .call-container .eb-vol-ring-svg .hit{
      stroke: transparent;
      stroke-width: 28;
      pointer-events: stroke;
    }
    .call-container .eb-vol-ring .label{
      display:flex;
      align-items:center;
      justify-content:center;
      font-size: 18px;
      line-height: 22px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
      padding: 8px 12px;
      border-radius: 999px;
      background: #040303a1;
      border: 1px solid rgba(255,255,255,.10);
      color: rgba(255,255,255,.92);
    }
    /* Mobile: don't show "громкость:" prefix */
    @media (hover: none){
      .call-container .eb-vol-ring .label .prefix{ display:none; }
    }
    .call-container .eb-vol-ring .center{
      position:absolute;
      left:50%;
      top:50%;
      transform: translate(-50%, -50%);
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:6px;
      opacity:0;
      transition: opacity 520ms cubic-bezier(.2,.8,.2,1), transform 520ms cubic-bezier(.2,.8,.2,1);
      transform: translate(-50%, -50%) scale(.985);
      pointer-events:none;
    }
    .call-container .lk-participant-tile:hover .eb-vol-ring .center,
    .call-container .lk-participant-tile:focus-within .eb-vol-ring .center{
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    .call-container .eb-vol-ring .actions{
      display:flex;
      gap:6px;
      pointer-events:auto;
    }
    .call-container .eb-vol-ring .actions .btn{
      border: 1px solid rgba(255,255,255,.10);
      background: #040303a1;
      color: rgba(255,255,255,.92);
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 14px;
      line-height: 18px;
      cursor: pointer;
      user-select:none;
      -webkit-tap-highlight-color: transparent;
    }
    .call-container .eb-vol-ring .actions .btn:hover{
      background: #040303c1;
    }

    /* Spotlight / tiny tiles: show only mute/restore button */
    .call-container .eb-vol-ring[data-eb-compact="true"] .label{
      display:none;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions .btn.reset{
      display:none;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions{
      gap:0;
    }
    .call-container .eb-vol-ring[data-eb-compact="true"] .actions .btn{
      padding: 8px 14px;
      font-size: 14px;
      line-height: 18px;
    }
  `;if(f.useEffect(()=>{let i=!0;async function p(){if(!y||!u)return;const d=`conv-${u}`,x=await It.post("/livekit/token",{room:d,participantMetadata:{app:"eblusha",userId:l?.id,displayName:l?.displayName??l?.username,avatarUrl:c}});if(i){J(x.data.token),Z(x.data.url);try{const o=String(x.data.token||"").split(".");if(o.length>=2){const s=o[1].replace(/-/g,"+").replace(/_/g,"/"),T=JSON.parse(atob(s)),n=!!T?.video?.canPublishData||!!T?.video?.can_publish_data;dt("lk-debug-ping","lkDebugPing")&&console.log("[Ping] LiveKit grant canPublishData:",n)}}catch{}}}return p(),()=>{i=!1,J(null),Z(null)}},[y,u]),f.useEffect(()=>{y&&(w(!!z),M(!W),rt(!1))},[y,z,W]),f.useEffect(()=>{if(!y)return;if(typeof window<"u"&&window.innerWidth<=768){const p=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=p}}},[y]),f.useEffect(()=>{y||(m.current=!1,a.current=!1)},[y]),f.useEffect(()=>{const i=()=>nt(typeof window<"u"?window.innerWidth>768:!0);return window.addEventListener("resize",i),()=>window.removeEventListener("resize",i)},[]),f.useEffect(()=>{if(!y)return;const i=document.body;if(!i)return;const p=()=>{const s=new Set;document.querySelectorAll(".call-container [aria-label], .call-container [title]").forEach(n=>s.add(n)),document.querySelectorAll(".call-container .lk-control-bar button, .call-container button.lk-button").forEach(n=>s.add(n)),s.forEach(n=>{const k=n.getAttribute("aria-label")||n.getAttribute("title")||"";let g="";const t=k.toLowerCase();if(t.includes("microphone")?g=k.includes("mute")?"Выключить микрофон":"Включить микрофон":t.includes("camera")?g=k.includes("disable")||t.includes("off")?"Выключить камеру":"Включить камеру":t.includes("screen")?g=t.includes("stop")?"Остановить показ экрана":"Поделиться экраном":t.includes("flip")?g="Сменить камеру":t.includes("participants")?g="Участники":t.includes("settings")?g="Настройки":t.includes("leave")||t.includes("hang")?g="Выйти":t.includes("chat")&&(g="Чат"),g&&(n.setAttribute("aria-label",g),n.setAttribute("title",g)),n.tagName==="BUTTON"){const b=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let U=b.nextNode();for(;U;){const S=(U.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();let P=null;S==="leave"?P="Выйти":S==="participants"?P="Участники":S==="settings"?P="Настройки":S==="microphone"?P="Микрофон":S==="camera"?P="Камера":S==="connecting"?P="Подключение":S==="reconnecting"?P="Переподключение":S==="disconnected"?P="Отключено":(S==="screen share"||S==="share screen"||S==="share-screen"||S==="share-screen "||S.includes("share")&&S.includes("screen"))&&(P="Показ экрана"),P&&(U.nodeValue=P,n.setAttribute("aria-label",P),n.setAttribute("title",P)),U=b.nextNode()}}}),document.querySelectorAll(".call-container .lk-toast-connection-state").forEach(n=>{const k=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let g=k.nextNode();for(;g;){const b=(g.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();b==="connecting"?g.nodeValue="Подключение":b==="reconnecting"?g.nodeValue="Переподключение":b==="disconnected"&&(g.nodeValue="Отключено"),g=k.nextNode()}});const T=i.querySelector(".call-container .lk-control-bar")||i.querySelector(".call-container [data-lk-control-bar]")||i.querySelector('.call-container [role="toolbar"]');if(T&&F){let n=T.querySelector(".eb-minimize-btn");if(!n){if(n=document.createElement("button"),n.className="eb-minimize-btn lk-button",n.setAttribute("aria-label","Свернуть"),n.setAttribute("title","Свернуть"),n.setAttribute("type","button"),n.innerHTML=`
            <span style="display: flex; align-items: center; gap: 8px;">
              <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
                <g id="IconSvg_bgCarrier" stroke-width="0"></g>
                <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
                <g id="IconSvg_iconCarrier">
                  <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961 3.75 10.496 10.68 10.496 18.18z"></path>
                  <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                </g>
              </svg>
              <span style="font-size: 14px;">Свернуть</span>
            </span>
          `,!n.__ebMinBound){n.__ebMinBound=!0;const g=t=>{t.preventDefault(),t.stopPropagation();try{F?.()}catch(b){console.error("Minimize click error",b)}};n.__ebMinHandler=g,n.addEventListener("click",g,!0),n.addEventListener("pointerup",g,!0),n.addEventListener("touchend",g,!0),n.addEventListener("keydown",t=>{t?.key!=="Enter"&&t?.key!==" "||g(t)})}n.style.pointerEvents="auto",n.disabled=!1;let k=T.querySelector("button.lk-disconnect-button")||T.querySelector('[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]');if(k&&k.parentNode){if(!k.__ebLeaveBound){const g=t=>{a.current=!0};k.addEventListener("click",g,!0),k.__ebLeaveBound=g}k.parentNode.insertBefore(n,k)}else T.appendChild(n)}if(n){const k=`
            <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
              <g id="IconSvg_bgCarrier" stroke-width="0"></g>
              <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
              <g id="IconSvg_iconCarrier">
                <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
              </g>
            </svg>`,g=`
            <span style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px; font-family: inherit; font-weight: 500; line-height: 20px;">Свернуть</span>
              ${k}
            </span>`;n.innerHTML=O?g:k,n.style.height="44px",n.style.minHeight="44px",n.style.padding="0 12px",n.style.display="flex",n.style.alignItems="center",n.style.justifyContent="flex-start",n.style.fontFamily="inherit",n.style.fontSize="14px",n.style.fontWeight="500",n.style.lineHeight="20px",n.style.pointerEvents="auto",n.disabled=!1,n.style.marginLeft="auto",n.parentElement===T&&T.lastElementChild!==n&&T.appendChild(n)}}};let d=!1;const x=()=>{d||(d=!0,requestAnimationFrame(()=>{d=!1,p()}))},o=new MutationObserver(()=>x());return o.observe(i,{childList:!0,subtree:!0,attributes:!0}),p(),()=>{o.disconnect();const s=i.querySelector(".call-container .lk-control-bar button.lk-disconnect-button")||i.querySelector('.call-container .lk-control-bar [aria-label*="Выйти" i], .call-container .lk-control-bar [title*="Выйти" i], .call-container .lk-control-bar [aria-label*="leave" i], .call-container .lk-control-bar [title*="leave" i]');s&&s.__ebLeaveBound&&(s.removeEventListener("click",s.__ebLeaveBound,!0),delete s.__ebLeaveBound)}},[y,F,v,O]),f.useEffect(()=>{if(!y)return;const i=document.body;if(!i)return;const p=L||null,d=()=>{i.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(s=>{const T=s.getAttribute("data-lk-local-participant")==="true"||s.dataset?.lkLocalParticipant==="true";let n=s.getAttribute("data-lk-participant-identity")||"";if(!n){const S=s.querySelector("[data-lk-participant-identity]");S&&(n=S.getAttribute("data-lk-participant-identity")||"")}if(!(T||!!(n&&p&&n===p)))return;const t=s.querySelector(".lk-participant-name, [data-lk-participant-name]");if(!t)return;const b=t.textContent||"",U=b.replace(/\s*\(мы\)\s*$/,"").trim();if(!U)return;const r=`${U} (мы)`;b!==r&&(t.textContent=r,t.hasAttribute("data-lk-participant-name")&&t.setAttribute("data-lk-participant-name",r))})};d();const x=new MutationObserver(()=>{setTimeout(d,50)});return x.observe(i,{childList:!0,subtree:!0,characterData:!0}),()=>x.disconnect()},[y,L]),f.useEffect(()=>{if(!y)return;const i=document.body;if(!i)return;const p=B||{},d=j||{},x=L||null,o=c||null,s=dt("lk-debug-avatars","lkDebugAvatars"),T=t=>{let b=0;for(let r=0;r<t.length;r++)b=t.charCodeAt(r)+((b<<5)-b);return`hsl(${Math.abs(b)%360} 70% 45%)`},n=(t,b)=>{const U=T(b),r=t.trim().charAt(0).toUpperCase(),S=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs/><rect width="256" height="256" rx="128" fill="${U}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="140" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" fill="#ffffff">${r}</text></svg>`;return`data:image/svg+xml;utf8,${encodeURIComponent(S)}`},k=()=>{i.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(b=>{const U=b.querySelector(".lk-participant-name, [data-lk-participant-name]"),r=b.querySelector(".lk-participant-placeholder");if(!U||!r)return;const S=b.querySelector("video.lk-participant-media-video")||b.querySelector("video"),Q=!!(!(b.getAttribute("data-video-muted")==="true"||b.getAttribute("data-lk-video-muted")==="true"||b.dataset?.videoMuted==="true"||b.dataset?.lkVideoMuted==="true")&&S&&S.offsetWidth>0&&S.offsetHeight>0);if(b.setAttribute("data-eb-has-video",Q?"true":"false"),Q){r.style.position="",r.style.inset="",r.style.left="",r.style.top="",r.style.right="",r.style.bottom="",r.style.transform="",r.style.width="",r.style.height="",r.style.maxWidth="",r.style.maxHeight="",r.style.minWidth="",r.style.minHeight="",r.style.margin="";return}let D="";const V={};for(let $=0;$<b.attributes.length;$++){const st=b.attributes[$];st.name.startsWith("data-")&&(V[st.name]=st.value)}const G=b.getAttribute("data-lk-participant-identity");if(G&&(D=G.trim()),!D){const $=b.querySelector("[data-lk-participant-identity]");$&&(D=($.getAttribute("data-lk-participant-identity")||"").trim())}if(!D){const $=b.dataset?.lkParticipantIdentity||b.dataset?.lkParticipantIdentity;$&&(D=String($).trim())}if(!D){const $=["data-participant-identity","data-identity","data-participant-id","data-user-id"];for(const st of $){const ht=b.getAttribute(st);if(ht){D=ht.trim();break}}}const N=b.getAttribute("data-lk-participant-metadata")||(b.dataset?b.dataset.lkParticipantMetadata:"")||"";let E=null;if(N)try{E=JSON.parse(N)}catch{E=null}E?.userId&&(D=String(E.userId).trim());let q=(U.textContent||U.getAttribute("data-lk-participant-name")||"").trim();const ot=q.replace(/\s*\(мы\)\s*$/,"").trim();if(!q&&E?.displayName&&(q=String(E.displayName).trim()),!q){const $=b.querySelector(".lk-participant-metadata");$?.textContent?.trim()&&(q=$.textContent.trim())}q||(q=D||"");const ct=!!(D&&x&&D===x),St=D?d[D]??null:null,pt=ot||q.replace(/\s*\(мы\)\s*$/,"").trim(),gt=Object.keys(p).find($=>$.toLowerCase()===pt.toLowerCase()),Tt=gt?p[gt]:null;let ft=St??Tt??(ct?o||(x?d[x]??null:null):null);const ut=n(pt||D||"U",D||pt||"U");if(s&&!ft&&(D||q)){const $=Object.keys(p),st=q?$.find(ht=>ht.toLowerCase()===q.toLowerCase()):null;console.log("[Avatars] Avatar not found:",{identity:D||"(empty)",name:q||"(empty)",isLocal:ct,localIdRef:x||"(empty)",byIdHasIdentity:D?D in d:!1,byNameHasName:!!st,nameMatch:st||"(no match)",participantMeta:E?{userId:E.userId,displayName:E.displayName}:null})}r.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach($=>$.remove()),r.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach($=>$.style.display="none");let H=r.querySelector("img.eb-ph");H||(H=document.createElement("img"),H.className="eb-ph",r.appendChild(H),H.onerror=()=>{H&&H.src!==ut&&(s&&console.log("[Avatars] Avatar image failed to load, using fallback:",H.src),H.src=ut)}),H.src!==(ft||ut)&&(H.src=ft||ut);const bt=b.getBoundingClientRect(),Rt=Math.min(bt.width,bt.height),it=Math.floor(Rt*.95);r.style.position="absolute",r.style.inset="auto",r.style.left="50%",r.style.top="50%",r.style.right="auto",r.style.bottom="auto",r.style.transform="translate(-50%, -50%)",r.style.width=`${it}px`,r.style.height=`${it}px`,r.style.maxWidth=`${it}px`,r.style.maxHeight=`${it}px`,r.style.minWidth=`${it}px`,r.style.minHeight=`${it}px`,r.style.flexShrink="0",r.style.display="flex",r.style.alignItems="center",r.style.justifyContent="center",r.style.background="transparent",r.style.backgroundImage="none",r.style.color="transparent",r.style.fontSize="0",r.style.overflow="hidden",r.style.margin="0",r.style.borderRadius="50%",r.style.aspectRatio="1",H.alt=q,H.style.aspectRatio="1",H.style.width="80%",H.style.height="80%",H.style.maxWidth="80%",H.style.maxHeight="80%",H.style.objectFit="cover",H.style.borderRadius="50%",H.style.display="block",H.style.margin="auto",Array.from(r.childNodes).forEach($=>{$.nodeType===Node.TEXT_NODE&&($.textContent="")})})},g=new MutationObserver(k);return g.observe(i,{childList:!0,subtree:!0}),k(),()=>g.disconnect()},[y,B,j,L,c]),!y||!u||!I||!tt)return null;const e=R.jsx("div",{className:"call-overlay",onClick:i=>{i.stopPropagation()},onTouchStart:i=>{i.stopPropagation()},style:{position:"fixed",inset:0,background:C?"transparent":"rgba(10,12,16,0.55)",backdropFilter:C?"none":"blur(4px) saturate(110%)",display:C?"none":O?"flex":"block",alignItems:O?"center":void 0,justifyContent:O?"center":void 0,zIndex:1e3,pointerEvents:C?"none":"auto"},children:R.jsxs("div",{"data-lk-theme":"default",style:{width:C?0:O?"90vw":"100vw",height:C?0:O?"80vh":"100vh",minHeight:C?0:O?void 0:"100dvh",maxWidth:C?0:O?1200:"100vw",background:"var(--surface-200)",borderRadius:O?16:0,overflow:"hidden",position:"relative",border:O?"1px solid var(--surface-border)":"none",boxShadow:C?"none":O?"var(--shadow-sharp)":"none",opacity:C?0:1,visibility:C?"hidden":"visible"},className:"call-container",children:[R.jsx("style",{children:h}),R.jsx(Bt,{serverUrl:tt,token:I,connect:!0,video:Y,audio:!et,onConnected:()=>{rt(!0);try{u&&K&&(dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] joinCallRoom emit",{conversationId:u,video:z}),jt(u,z),Et([u]))}catch(i){console.error("Error joining call room:",i)}},onDisconnected:i=>{dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] onDisconnected:",i,"wasConnected:",A,"isGroup:",K,"minimized:",C);const p=A;rt(!1);const d=i===1||a.current;C||(K?p&&d&&v({manual:!0}):d&&v({manual:!0}))},children:R.jsxs("div",{style:{width:"100%",height:"100%"},children:[R.jsx(Vt,{}),R.jsx(Xt,{}),R.jsx(Zt,{localUserId:L}),R.jsx(Jt,{}),R.jsx(Kt,{SettingsComponent:Yt})]})})]})});return Ft.createPortal(e,document.body)}export{ae as CallOverlay};
