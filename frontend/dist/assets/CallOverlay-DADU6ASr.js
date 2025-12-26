import{r as y,j as C}from"./vendor-query-CNP5Hy5J.js";import{u as _t,P as Pt,m as At,e as Lt,d as Dt,M as jt}from"./index-VigeMbMx.js";import{W as It,a as qt,t as Ft,C as xt,u as yt,O as Tt,R as ht,f as wt,T as Mt,b as Bt,s as Ot,L as Wt}from"./index-BRAGuiMP.js";import{X as $t}from"./ChatsPage-nGwG83c1.js";import"./vendor-react-BcTlWpV0.js";import"./vendor-socket-CA1CrNgP.js";import"./vendor-crypto-GGjuBpPe.js";if(typeof window<"u"&&typeof navigator<"u"&&navigator.mediaDevices&&!window.__eblushaEnumeratePatched){const v=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=>{const f=await v(),_=navigator.userAgent||"";if(!/iP(ad|hone|od)/i.test(_))return f;const P=[],B=[],K=[],J=(I,T)=>{const q=I.toLowerCase();return/(front|перед|selfie|true depth|ultra wide front)/.test(q)?"front":/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(q)||/(back|rear)/.test(T.toLowerCase())?"back":"other"};f.forEach(I=>{if(I.kind!=="videoinput"){K.push(I);return}const T=J(I.label||"",I.deviceId||"");T==="front"?P.push(I):B.push(I)});const X=[];if(P.length>0&&X.push(P[0]),B.length>0&&X.push(B[0]),X.length===0&&f.some(I=>I.kind==="videoinput")){const I=f.find(T=>T.kind==="videoinput");I&&X.push(I)}return K.forEach(I=>{I.kind!=="videoinput"&&X.push(I)}),X},window.__eblushaEnumeratePatched=!0}try{Ot(Wt.warn)}catch{}const ut={aec:"eb.lk.webrtc.aec",ns:"eb.lk.webrtc.ns",agc:"eb.lk.webrtc.agc"};function St(v,f){if(typeof window>"u")return f;try{const _=window.localStorage.getItem(v);return _===null?f:_==="1"||_==="true"}catch{return f}}function Rt(v,f){if(!(typeof window>"u"))try{window.localStorage.setItem(v,f?"1":"0")}catch{}}function dt(v,f){if(typeof window>"u")return!1;try{const O=new URLSearchParams(window.location.search).get(f);if(O==="1"||O==="true")return!0;const P=window.localStorage.getItem(v);return P==="1"||P==="true"}catch{return!1}}function Ct({label:v,description:f,checked:_,onChange:O,disabled:P=!1,rightHint:B}){return C.jsxs("div",{className:"eb-toggle-row",children:[C.jsxs("div",{className:"eb-toggle-text",children:[C.jsx("div",{className:"eb-toggle-label",children:v}),f?C.jsx("div",{className:"eb-toggle-desc",children:f}):null]}),C.jsxs("div",{className:"eb-toggle-right",children:[B?C.jsx("div",{className:"eb-toggle-hint",children:B}):null,C.jsxs("label",{className:`eb-switch ${P?"is-disabled":""}`,children:[C.jsx("input",{type:"checkbox",checked:_,disabled:P,onChange:K=>O(K.target.checked)}),C.jsx("span",{className:"eb-switch-track","aria-hidden":"true"})]})]})]})}function zt(){const v=Ft();let f="Подключено";return v===xt.Connecting?f="Подключение…":v===xt.Reconnecting?f="Переподключение…":v===xt.Disconnected&&(f="Отключено"),C.jsx("div",{className:"eb-conn-badge",style:{position:"absolute",top:10,left:10,zIndex:20,padding:"6px 10px",borderRadius:999,background:"rgba(0,0,0,0.45)",border:"1px solid rgba(255,255,255,0.12)",fontSize:12,color:"#fff",backdropFilter:"blur(6px)"},children:f})}function Ht(){const v=yt(),{isMicrophoneEnabled:f}=Tt(),_=y.useRef(!1);return y.useEffect(()=>{v&&(_.current||f&&(_.current=!0,v.localParticipant.setMicrophoneEnabled(!0,{deviceId:"default"}).catch(O=>console.warn("[DefaultMicrophoneSetter] Failed to set default microphone",O))))},[v,f]),null}function Ut({localUserId:v}){const f=yt(),{localParticipant:_,microphoneTrack:O,cameraTrack:P}=Tt(),[B,K]=y.useState(null),J=y.useRef(null),[X,I]=y.useState(null),T=y.useRef(null),q=y.useRef(null),H=y.useRef(new Map),et=y.useRef(new Map),tt=y.useRef(0),V=y.useRef(!1),it=y.useRef(!1),U=y.useRef(0),G=y.useRef({at:0,rtt:null}),[g,M]=y.useState(()=>dt("lk-debug-ping","lkDebugPing")),Q=y.useRef({at:0,lastLocalRtt:null,lastSignalRtt:null}),E=(...m)=>{g&&console.log("[Ping]",...m)};y.useEffect(()=>{const m=window.setInterval(()=>{const l=dt("lk-debug-ping","lkDebugPing");M(b=>b===l?b:l)},1e3);return()=>window.clearInterval(m)},[]),y.useEffect(()=>{if(g){E("debug enabled",{localStorage:(()=>{try{return window.localStorage.getItem("lk-debug-ping")}catch{return"(unavailable)"}})(),query:(()=>{try{return new URLSearchParams(window.location.search).get("lkDebugPing")}catch{return"(unavailable)"}})(),localIdentity:_?.identity??null});try{const l=performance?.getEntriesByType?.("resource")?.map(b=>b.name).find(b=>b.includes("/assets/CallOverlay-"))??null;l&&E("asset",l)}catch{}}},[g,_?.identity]),y.useEffect(()=>{T.current=X,q.current?.(),g&&E("localPlayoutMs state",X)},[X]),y.useEffect(()=>{if(!f)return;const m=h=>{let e=null;try{h.forEach(a=>{if(a?.type!=="inbound-rtp")return;const u=(a?.kind||a?.mediaType||"").toString().toLowerCase();if(u&&u!=="audio")return;const c=typeof a?.jitterBufferTargetDelay=="number"?a.jitterBufferTargetDelay:null;if(typeof c=="number"&&Number.isFinite(c)&&c>0){const o=c*1e3;Number.isFinite(o)&&o>0&&o<5e3&&(e=e===null?o:Math.max(e,o))}const x=typeof a?.jitterBufferDelay=="number"?a.jitterBufferDelay:null,r=typeof a?.jitterBufferEmittedCount=="number"?a.jitterBufferEmittedCount:null;if(typeof x=="number"&&typeof r=="number"&&Number.isFinite(x)&&Number.isFinite(r)&&x>0&&r>=50){const o=x/r*1e3;Number.isFinite(o)&&o>0&&o<5e3&&(e=e===null?o:Math.max(e,o))}})}catch{}return e};let l=!1;const b=async()=>{try{const e=f.engine?.pcManager?.subscriber;if(e?.getStats){const a=await e.getStats(),u=m(a);l||I(u),g&&E("playout sample",{ms:u});return}}catch(h){g&&E("playout sample failed",h)}l||I(null)},S=window.setInterval(b,2e3);return b(),()=>{l=!0,window.clearInterval(S)}},[f,g]);const at=m=>m.getAttribute("data-lk-local-participant")==="true"?!0:m.dataset?.lkLocalParticipant==="true",s=m=>{const l=m.querySelector("[data-lk-participant-name]")||m.querySelector(".lk-participant-name"),b=l?.getAttribute("data-lk-participant-name"),S=b&&b.trim()||(l?.textContent?.trim()??"");return S?S.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null};return y.useEffect(()=>{if(!f||!_)return;const m=h=>{try{let e=null;const a=r=>{const o=(typeof r?.currentRoundTripTime=="number"?r.currentRoundTripTime:null)??(typeof r?.roundTripTime=="number"?r.roundTripTime:null)??(typeof r?.totalRoundTripTime=="number"&&Number.isFinite(r.totalRoundTripTime)&&r.totalRoundTripTime>0&&typeof r?.responsesReceived=="number"&&Number.isFinite(r.responsesReceived)&&r.responsesReceived>0?r.totalRoundTripTime/r.responsesReceived:null);return typeof o!="number"||!Number.isFinite(o)||o<=0?null:o};let u=null,c=null;h.forEach(r=>{r?.type==="transport"&&r.selectedCandidatePairId&&(u=String(r.selectedCandidatePairId))}),u&&(c=h.get?.(u)??(()=>{let r=null;return h.forEach(o=>{r||o?.id===u&&(r=o)}),r})()??null),c||h.forEach(r=>{c||r?.type==="candidate-pair"&&(r.selected||r.nominated||r.state==="succeeded")&&(c=r)});const x=c?a(c):null;if(typeof x=="number"&&Number.isFinite(x)&&x>0&&(e=x),h.forEach(r=>{if(r?.type!=="candidate-pair"||!(r.selected||r.nominated||r.state==="succeeded"))return;const o=a(r);typeof o=="number"&&(e===null||o<e)&&(e=o)}),h.forEach(r=>{if(r?.type!=="remote-inbound-rtp")return;const o=(typeof r?.roundTripTime=="number"?r.roundTripTime:null)??(typeof r?.totalRoundTripTime=="number"&&Number.isFinite(r.totalRoundTripTime)&&r.totalRoundTripTime>0&&typeof r?.roundTripTimeMeasurements=="number"&&Number.isFinite(r.roundTripTimeMeasurements)&&r.roundTripTimeMeasurements>0?r.totalRoundTripTime/r.roundTripTimeMeasurements:null);typeof o!="number"||!Number.isFinite(o)||o<=0||(e===null||o<e)&&(e=o)}),h.forEach(r=>{const o=typeof r?.roundTripTime=="number"?r.roundTripTime:null;typeof o!="number"||!Number.isFinite(o)||o<=0||(e===null||o<e)&&(e=o)}),typeof e=="number"&&Number.isFinite(e)&&e>0)return e*1e3}catch{}return null},l=async()=>{try{const h=f.engine,e=h?.client?.rtt;if((!e||e<=0)&&typeof h?.client?.sendPing=="function"){const n=Date.now();if(n-U.current>5e3){U.current=n;try{await h.client.sendPing(),g&&E("signal sendPing() called")}catch(k){g&&E("signal sendPing() failed",k)}}}if(g){const n=Date.now(),k=Q.current;(typeof e=="number"?e:null)!==k.lastSignalRtt&&n-k.at>750&&(Q.current={...k,at:n,lastSignalRtt:typeof e=="number"?e:null},E("signal rtt",{rtt:e,hasEngine:!!h,localIdentity:_.identity}))}if(typeof e=="number"&&Number.isFinite(e)&&e>0){K(e),g&&E("local rtt set",{ms:Math.round(e),source:"engine.client.rtt"});return}const a=O?.track;if(a&&typeof a.getSenderStats=="function")try{const n=await a.getSenderStats(),k=typeof n?.roundTripTime=="number"?n.roundTripTime:null;if(typeof k=="number"&&Number.isFinite(k)&&k>0){const d=k*1e3;K(d),g&&E("local rtt set",{ms:Math.round(d),source:"LocalAudioTrack.getSenderStats().roundTripTime"});return}}catch(n){g&&E("mic getSenderStats failed",n)}const u=P?.track;if(u&&typeof u.getSenderStats=="function")try{const n=await u.getSenderStats(),d=(Array.isArray(n)?n:[]).map(t=>typeof t?.roundTripTime=="number"?t.roundTripTime:null).filter(t=>typeof t=="number"&&Number.isFinite(t)&&t>0);if(d.length>0){const p=Math.min(...d)*1e3;K(p),g&&E("local rtt set",{ms:Math.round(p),source:"LocalVideoTrack.getSenderStats()[].roundTripTime"});return}}catch(n){g&&E("camera getSenderStats failed",n)}const c=Date.now();if(c-tt.current<3e3)return;const x=h?.pcManager?.publisher,r=h?.pcManager?.subscriber,o=[x,r].filter(Boolean),N=[O?.track,P?.track].filter(Boolean);if(o.length>0||N.length>0)tt.current=c;else{g&&!it.current&&(it.current=!0,E("waiting for transports/tracks",{publisher:!!x,subscriber:!!r,trackCandidates:N.length}));return}for(const n of o){if(!n?.getStats)continue;const k=await n.getStats(),d=m(k);if(typeof d=="number"&&Number.isFinite(d)&&d>0){K(d),g&&E("local rtt set",{ms:Math.round(d),source:"pcTransport.getStats()"});return}}for(const n of N){if(!n?.getRTCStatsReport)continue;const k=await n.getRTCStatsReport();if(!k)continue;const d=m(k);if(typeof d=="number"&&Number.isFinite(d)&&d>0){K(d),g&&E("local rtt set",{ms:Math.round(d),source:"MediaStreamTrack.getRTCStatsReport()"});return}}V.current||(V.current=!0,g&&E("could not compute local rtt",{signalRtt:e,transports:o.length,trackCandidates:N.length,localIdentity:_.identity}))}catch(h){g&&E("updateRtt error",h)}},b=setInterval(()=>void l(),1500);l();const S=setTimeout(()=>void l(),2500);return()=>{clearInterval(b),clearTimeout(S)}},[f,_,O?.trackSid,P?.trackSid]),y.useEffect(()=>{if(!f||!_)return;const m=new TextEncoder,l=async()=>{try{const e=J.current;if(typeof e!="number"||!Number.isFinite(e)||e<=0){g&&E("skip publish eb.ping (no local rtt yet)",{localRtt:e});return}const a=Date.now(),u=G.current,c=u.rtt===null||Math.abs(u.rtt-e)>=2;if(!(a-u.at>=2e3)&&!c)return;G.current={at:a,rtt:e};const r=T.current,o={t:"eb.ping",v:2,rtt:Math.round(e),playoutMs:typeof r=="number"&&Number.isFinite(r)&&r>=0?Math.round(r):0,ts:a};await _.publishData(m.encode(JSON.stringify(o)),{reliable:!1,topic:"eb.ping"}),g&&E("publish eb.ping ok",o)}catch(e){g&&E("publish eb.ping failed",e),g&&!window.__ebPingPublishWarned&&(window.__ebPingPublishWarned=!0,console.warn("[Ping] Failed to publish eb.ping (data channel). Check LiveKit token grant canPublishData=true."))}},b=new TextDecoder,S=(e,a,u,c)=>{if(c&&c!=="eb.ping")return;const x=a?.identity;if(x&&!(_&&x===_.identity))try{const r=JSON.parse(b.decode(e));if(!r||r.t!=="eb.ping")return;const o=Number(r.rtt);if(!Number.isFinite(o)||o<=0)return;const N=Number(r.playoutMs),n=Number.isFinite(N)&&N>=0?N:0,k=typeof a?.name=="string"&&a.name?a.name:null,d=H.current.get(x);H.current.set(x,o),k&&H.current.set(k,o),et.current.set(x,n),k&&et.current.set(k,n);const t=typeof a?.metadata=="string"?a.metadata:null;if(t)try{const p=JSON.parse(t);p?.displayName&&H.current.set(String(p.displayName),o),p?.userId&&H.current.set(String(p.userId),o),p?.displayName&&et.current.set(String(p.displayName),n),p?.userId&&et.current.set(String(p.userId),n)}catch{}g&&(d===void 0||Math.abs(d-o)>=2)&&E("recv eb.ping",{from:x,name:k,rtt:o,playoutMs:n,ts:r.ts,topic:c??null}),q.current?.()}catch{}};f.on(ht.DataReceived,S);const h=setInterval(()=>void l(),2e3);return l(),()=>{clearInterval(h),f.off(ht.DataReceived,S)}},[f,_,g]),y.useEffect(()=>{J.current=B,q.current?.(),g&&E("localRtt state",B)},[B]),y.useEffect(()=>{if(!f)return;const m=document.querySelector(".call-container");if(!m)return;const l=a=>{const u=J.current;return typeof u!="number"||!Number.isFinite(u)||u<=0?"—":a?`${Math.round(u)} мс`:"—"},b=()=>{const a=m.querySelectorAll(".lk-participant-metadata-item[data-lk-quality]");g&&E("dom scan",{indicators:a.length}),a.forEach(u=>{const c=u.closest(".lk-participant-tile, [data-participant]");if(!c)return;const x=at(c),r=s(c);u.classList.contains("eb-ping-display")||u.classList.add("eb-ping-display");let o=u.querySelector(".eb-ping-text");o||(o=document.createElement("span"),o.className="eb-ping-text",u.appendChild(o));let N=null,n=l(x);if(x){const t=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&(N=Math.round(t),n=`${N} мс`)}else{const t=(r?H.current.get(r):void 0)??void 0,p=(r?et.current.get(r):void 0)??0,$=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&typeof $=="number"&&$>0&&(N=Math.round((t+$)/2+(typeof p=="number"&&Number.isFinite(p)&&p>=0?p:0)),n=`${N} мс`)}const k=typeof N=="number"&&Number.isFinite(N)&&N>0;if(u.classList.toggle("eb-ping-has-value",k),typeof N=="number"&&Number.isFinite(N)&&N>0){const t=N<=200?"good":N<=500?"warn":"bad";u.setAttribute("data-eb-ping-level",t)}else u.removeAttribute("data-eb-ping-level");const d=k?n:"";if(o.textContent!==d&&(o.textContent=d,g)){const t=J.current,p=r?H.current.get(r):void 0;E("dom set",{name:r,isLocal:x,text:d,mine:t,remote:p})}})};let S=!1;const h=()=>{S||(S=!0,requestAnimationFrame(()=>{S=!1,b()}))};q.current=h;const e=new MutationObserver(()=>h());return e.observe(m,{childList:!0,subtree:!0}),h(),()=>{q.current===h&&(q.current=null),e.disconnect()}},[f,_,v,g]),null}function Kt(){const v=yt(),f=y.useRef(null),_=y.useRef(new Map),O=y.useRef(0),P=y.useRef(new WeakMap),B=y.useRef(new Map),K=s=>s.getAttribute("data-lk-local-participant")==="true"?!0:s.dataset?.lkLocalParticipant==="true",J=s=>{const m=s.querySelector("[data-lk-participant-name]")||s.querySelector(".lk-participant-name"),l=m?.getAttribute("data-lk-participant-name"),b=l&&l.trim()||(m?.textContent?.trim()??"");return b?b.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null},X=s=>{const m=s.getAttribute("data-lk-participant-identity")||s.getAttribute("data-participant-identity")||s.getAttribute("data-user-id")||s.dataset?.lkParticipantIdentity||"",l=String(m||"").trim();if(l)return l;const b=s.getAttribute("data-lk-participant-metadata")||(s.dataset?s.dataset.lkParticipantMetadata:"")||"";if(b)try{const S=JSON.parse(b);if(S?.userId)return String(S.userId).trim()}catch{}return null},I=s=>{const m=X(s),l=J(s),b=m||l;return b?{key:b,userId:m,name:l}:null},T=s=>{const m=_.current,l=m.get(s);if(l)return l;const b={volume:1,muted:!1,lastNonZeroPct:100};return m.set(s,b),b},q=async()=>{if(O.current=Date.now(),f.current){try{f.current.state!=="running"&&await f.current.resume()}catch{}return f.current}try{const s=new(window.AudioContext||window.webkitAudioContext);f.current=s;try{s.state!=="running"&&await s.resume()}catch{}return s}catch{return null}},H=s=>{const m=s?.metadata;if(!m||typeof m!="string")return null;try{const l=JSON.parse(m);if(!l||typeof l!="object")return null;const b=l.userId?String(l.userId):void 0,S=l.displayName?String(l.displayName):void 0;return{userId:b,displayName:S}}catch{return null}},et=s=>{if(!v)return null;const m=(s.userId?v.remoteParticipants.get(s.userId):null)||v.remoteParticipants.get(s.key)||null;if(m)return m;const l=(s.name||"").trim(),b=(s.key||"").trim(),S=(s.userId||"").trim();for(const h of v.remoteParticipants.values())try{if(S&&String(h.identity)===S||b&&String(h.identity)===b||l&&String(h.name||"").trim()===l)return h;const e=H(h);if(S&&e?.userId&&e.userId===S||l&&e?.displayName&&e.displayName.trim()===l)return h}catch{}return null},tt=async(s,m)=>{if(!v)return;const{key:l}=s,b=et(s);if(!b)return;const S=T(l),h=S.muted?0:S.volume,e=h>1,a=f.current||(e&&m?await q():null),u=[];try{const c=b.trackPublications;if(c?.values)for(const x of c.values())u.push(x)}catch{}for(const c of u){if(c?.kind!==Mt.Kind.Audio)continue;if(typeof c?.setEnabled=="function")try{c.setEnabled(!S.muted&&h>0)}catch{}const x=c?.track;if(!(x instanceof Bt))continue;if(a){const o=P.current.get(x);(!o||o.ctx!==a||!o.inited)&&(x.setAudioContext(a),P.current.set(x,{ctx:a,inited:!0}))}const r=S.muted?0:Math.max(0,Math.min(1.5,h));x.setVolume(r)}};y.useEffect(()=>{if(!v)return;const s=(m,l,b)=>{try{const S=String(b?.identity||""),h=String(b?.name||""),e=S||h;if(!e||b?.isLocal)return;_.current.has(e)&&m?.kind===Mt.Kind.Audio&&tt({key:e,userId:S||null,name:h||null},!1)}catch{}};return v.on(ht.TrackSubscribed,s),()=>{v.off(ht.TrackSubscribed,s)}},[v]);const V=150,it=100,U=105,G=2*Math.PI*U,g=s=>Math.max(0,Math.min(V,Math.round(s))),M=s=>g(s.muted?0:s.volume*100),Q=(s,m,l)=>{const b=Math.max(0,G-l);s.style.strokeDasharray=`${l} ${b}`,s.style.strokeDashoffset=`-${m}`,s.style.opacity=l>0?"1":"0"},E=(s,m,l)=>{const b=s.__ebRingSafe,S=s.__ebRingOver,h=s.__ebRingThumb,e=s.__ebRingLabel,a=s.__ebRingVal,u=s.__ebRingMuteBtn;if(!b||!S)return;const c=g(m),x=Math.min(c,it)/V,r=Math.max(c-it,0)/V,o=G*x,N=G*r;if(Q(b,0,o),Q(S,o,N),h){const k=c/V*(Math.PI*2),d=110+U*Math.cos(k),t=110+U*Math.sin(k);h.setAttribute("cx",`${d}`),h.setAttribute("cy",`${t}`),h.style.opacity="1"}a?a.textContent=`${c}%`:e&&(e.textContent=`${c}%`),u&&(u.textContent=l||c===0?"Вернуть":"Заглушить"),s.setAttribute("data-eb-over",c>it?"true":"false"),s.setAttribute("data-eb-muted",l||c===0?"true":"false")},at=(s,m)=>{const l=m.getBoundingClientRect(),b=l.left+l.width/2,S=l.top+l.height/2,h=s.clientX-b,e=s.clientY-S;let a=Math.atan2(e,h)*180/Math.PI;a=(a+90+360)%360;const u=a/360;return g(u*V)};return y.useEffect(()=>{if(!v)return;const s=document.body;if(!s)return;const m=()=>{try{s.querySelectorAll(".call-container .lk-participant-tile").forEach(e=>{if(K(e))return;const a=I(e);if(!a)return;e.setAttribute("data-eb-remote","true");const u=et(a),c=u?String(u.identity):a.key,r=(u?H(u):null)?.displayName||a.name||null,o={key:c,userId:c,name:r};e.setAttribute("data-eb-vol-key",c);const N=e.getAttribute("data-video-muted")==="true"||e.getAttribute("data-lk-video-muted")==="true"||e.dataset?.videoMuted==="true"||e.dataset?.lkVideoMuted==="true",n=e.querySelector("video.lk-participant-media-video")||e.querySelector("video");if(!!(!N&&n&&n.offsetWidth>0&&n.offsetHeight>0)){e.querySelectorAll(".eb-vol-ring").forEach(i=>i.remove());return}const d=e.querySelector(".lk-participant-placeholder");if(!d)return;e.style.position||(e.style.position="relative");let t=e.querySelector(".eb-vol-ring");if(t?t.setAttribute("data-eb-vol-key",c):(t=document.createElement("div"),t.className="eb-vol-ring",t.setAttribute("data-eb-vol-key",c),t.innerHTML=`
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
            `,e.appendChild(t)),!t.__ebRingInit){t.__ebRingInit=!0;const i=t.querySelector("svg.eb-vol-ring-svg"),w=t.querySelector("circle.safe"),L=t.querySelector("circle.over"),Y=t.querySelector("circle.thumb"),D=t.querySelector("circle.hit"),z=t.querySelector(".label"),Z=t.querySelector(".label .val"),R=t.querySelector("button.btn.mute"),A=t.querySelector("button.btn.reset");t.__ebRingSvg=i,t.__ebRingSafe=w,t.__ebRingOver=L,t.__ebRingThumb=Y,t.__ebRingHit=D,t.__ebRingLabel=z,t.__ebRingVal=Z,t.__ebRingMuteBtn=R,t.__ebRingResetBtn=A}const p=()=>{const i=T(c),w=M(i);w>0&&(i.lastNonZeroPct=w),E(t,w,!!i.muted)};try{const i=e.getBoundingClientRect(),w=e.offsetWidth||i.width||1,L=e.offsetHeight||i.height||1,Y=i.width?i.width/w:1,D=i.height?i.height/L:1,z=d.getBoundingClientRect(),R=d.querySelector("img.eb-ph")?.getBoundingClientRect(),A=R&&R.width>10?R.width:z.width*.8,j=(Y+D)/2||1,rt=A/j,st=R&&R.width>10?R.left-i.left+R.width/2:z.left-i.left+z.width/2,lt=R&&R.height>10?R.top-i.top+R.height/2:z.top-i.top+z.height/2,vt=st/Y-e.clientLeft,pt=lt/D-e.clientTop,mt=220,ft=105-10/2,ct=0,W=rt/2,gt=mt*(W+ct)/ft,kt=Math.min(Math.min(e.clientWidth||w,e.clientHeight||L)-6,gt),nt=Math.max(56,kt);nt<150?t.setAttribute("data-eb-compact","true"):t.removeAttribute("data-eb-compact"),t.style.width=`${nt}px`,t.style.height=`${nt}px`,t.style.left=`${vt}px`,t.style.top=`${pt}px`,t.style.transform="translate(-50%, -50%)"}catch{}const $=(i,w)=>{let L=g(i);const Y=String(t?.getAttribute("data-eb-vol-key")||c).trim();if(!Y)return;const D=typeof t.__ebLastPct=="number"?t.__ebLastPct:L;if(t.__ebDragging){const Z=L-D;Math.abs(Z)>V/2&&(L=D>V/2?V:0)}t.__ebLastPct=L;const z=T(Y);L===0?(z.muted=!0,z.volume=0):(z.muted=!1,z.lastNonZeroPct=L,z.volume=L/100),E(t,L,!!z.muted),tt({key:Y,userId:Y,name:null},w)};if(!t.__ebRingBound){t.__ebRingBound=!0;const i=t.__ebRingSvg,w=t.__ebRingHit,L=t.__ebRingMuteBtn,Y=t.__ebRingResetBtn;if(i&&w){w.addEventListener("pointerdown",R=>{R.preventDefault(),R.stopPropagation(),O.current=Date.now(),t.__ebDragging=!0;try{const j=String(t?.getAttribute("data-eb-vol-key")||"").trim();j&&(t.__ebLastPct=M(T(j)))}catch{}try{w.setPointerCapture?.(R.pointerId)}catch{}const A=at(R,i);$(A,!0)}),w.addEventListener("pointermove",R=>{if(!t.__ebDragging)return;R.preventDefault(),R.stopPropagation();const A=at(R,i);$(A,!0)});const Z=R=>{t.__ebDragging&&(t.__ebDragging=!1);try{w.releasePointerCapture?.(R.pointerId)}catch{}};w.addEventListener("pointerup",Z),w.addEventListener("pointercancel",Z)}const D=Z=>{Z.preventDefault(),Z.stopPropagation();const R=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!R)return;const A=T(R),j=M(A);if(A.muted||j===0){const st=g(A.lastNonZeroPct||100);A.muted=!1,A.lastNonZeroPct=Math.max(1,st),A.volume=A.lastNonZeroPct/100}else j>0&&(A.lastNonZeroPct=j),A.muted=!0,A.volume=0;const rt=M(A);t.__ebLastPct=rt,E(t,rt,!!A.muted),tt({key:R,userId:R,name:null},!0)},z=Z=>{Z.preventDefault(),Z.stopPropagation();const R=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!R)return;const A=T(R);A.muted=!1,A.lastNonZeroPct=100,A.volume=1;const j=M(A);t.__ebLastPct=j,E(t,j,!!A.muted),tt({key:R,userId:R,name:null},!0)};L?.addEventListener("click",D),Y?.addEventListener("click",z)}e.__ebVolWheelBound||(e.__ebVolWheelBound=!0,e.addEventListener("wheel",i=>{i.preventDefault(),i.stopPropagation();const w=String(e.getAttribute("data-eb-vol-key")||"").trim();if(!w)return;const L=T(w),Y=M(L),D=(i.deltaMode===1?i.deltaY*40:i.deltaMode===2?i.deltaY*(window.innerHeight||800):i.deltaY)||0,z=B.current,R=(z.get(w)||0)+D;z.set(w,R);const A=100,j=Math.trunc(Math.abs(R)/A);if(j<=0)return;const rt=j*A*Math.sign(R);z.set(w,R-rt);const st=i.shiftKey?2:1,lt=R<0?1:-1;$(Y+lt*j*st,!0)},{passive:!1})),p(),tt(o,!1)})}catch{}};let l=!1;const b=()=>{l||(l=!0,requestAnimationFrame(()=>{l=!1,m()}))},S=new MutationObserver(()=>b());return S.observe(s,{childList:!0,subtree:!0}),m(),()=>{S.disconnect()}},[v]),null}function Vt(){const v=yt(),{isMicrophoneEnabled:f,microphoneTrack:_}=Tt(),[O,P]=y.useState(()=>St(ut.aec,!0)),[B,K]=y.useState(()=>St(ut.ns,!0)),[J,X]=y.useState(()=>St(ut.agc,!0)),I=y.useRef("");return y.useEffect(()=>{if(!v||!f)return;const T=`${O}|${B}|${J}|${_?.trackSid??""}`;I.current!==T&&(I.current=T,v.localParticipant.setMicrophoneEnabled(!0,{echoCancellation:O,noiseSuppression:B,autoGainControl:J}).catch(q=>console.warn("[CallSettings] Failed to apply mic capture options",q)))},[v,f,O,B,J,_?.trackSid]),y.useEffect(()=>{const T=()=>{const et=document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li"),tt=[],V=new Map;et.forEach(U=>{const G=U.querySelector(".lk-button");if(!G)return;const g=G.textContent||"",M=/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i.test(g);let Q=g.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim();Q=Q.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),V.has(Q)||V.set(Q,[]),V.get(Q).push(U),M&&tt.push(U)}),tt.forEach(U=>{U.remove()}),document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button").forEach(U=>{const G=Array.from(U.childNodes).find(M=>M.nodeType===Node.TEXT_NODE);let g=U.querySelector("span.eb-device-label");if(G&&!g){const M=G.textContent||"";g=document.createElement("span"),g.className="eb-device-label",g.textContent=M,U.replaceChild(g,G)}if(g){let M=g.textContent||"";M=M.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim(),M=M.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),M=M.replace(/\s*\([0-9a-fA-F]{4}:\s*$/,"").trim(),M!==g.textContent&&(g.textContent=M),setTimeout(()=>{const Q=U.getBoundingClientRect(),E=g.getBoundingClientRect(),s=Q.width-24;if(E.width>s){const m=E.width-s;g.setAttribute("data-overflows","true"),g.style.setProperty("--eb-device-scroll-distance",`${-m}px`)}else g.removeAttribute("data-overflows"),g.style.removeProperty("--eb-device-scroll-distance")},10)}})};T();const q=new MutationObserver(()=>{setTimeout(T,50)}),H=document.querySelector(".call-container .lk-settings-menu-modal");if(H)return q.observe(H,{childList:!0,subtree:!0,characterData:!0}),()=>q.disconnect()},[]),C.jsxs("div",{className:"eb-call-settings",style:{width:"100%"},children:[C.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12},children:[C.jsx("div",{style:{fontSize:18,fontWeight:600},children:"Настройки"}),C.jsx("button",{type:"button",className:"btn btn-icon btn-ghost","aria-label":"Закрыть настройки",title:"Закрыть настройки",onClick:T=>{T.preventDefault(),T.stopPropagation();const q=document.querySelector(".call-container .lk-settings-toggle");if(q){q.click();return}const H=document.querySelector(".call-container .lk-settings-menu-modal");H&&(H.style.display="none")},style:{padding:8},children:C.jsx($t,{size:18})})]}),C.jsxs("div",{className:"eb-settings-section",children:[C.jsx("div",{className:"eb-section-title",children:"Обработка микрофона"}),C.jsx(Ct,{label:"WebRTC: AEC (анти-эхо)",description:"Эхо‑подавление на уровне браузера (лучше включать почти всегда).",checked:O,onChange:T=>{P(T),Rt(ut.aec,T)}}),C.jsx(Ct,{label:"WebRTC: NS (шумоподавление)",description:"Шумоподавление на уровне браузера.",checked:B,onChange:T=>{K(T),Rt(ut.ns,T)}}),C.jsx(Ct,{label:"WebRTC: AGC (автогейн)",description:"Автоматическая регулировка усиления микрофона.",checked:J,onChange:T=>{X(T),Rt(ut.agc,T)}}),C.jsx("div",{className:"eb-settings-note",children:"Изменения AEC/NS/AGC применяются перезапуском микрофона и могут дать короткий “пик” при переключении."})]}),C.jsxs("div",{className:"eb-settings-grid",style:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))",gap:16,alignItems:"start",marginBottom:12},children:[C.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[C.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Микрофон"}),C.jsx(wt,{kind:"audioinput",requestPermissions:!0})]}),C.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[C.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Камера"}),C.jsx(wt,{kind:"videoinput",requestPermissions:!0})]}),C.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[C.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Вывод звука"}),C.jsx(wt,{kind:"audiooutput",requestPermissions:!0}),C.jsx("div",{style:{fontSize:11,opacity:.65,marginTop:6},children:"На Safari/iOS переключение устройства вывода может быть недоступно."})]})]}),C.jsx("div",{style:{fontSize:12,opacity:.8},children:"Выберите устройства ввода. Закрыть это окно можно кнопкой «Настройки» внизу."})]})}function ee({open:v,conversationId:f,onClose:_,onMinimize:O,minimized:P=!1,initialVideo:B=!1,initialAudio:K=!0,peerAvatarUrl:J=null,avatarsByName:X={},avatarsById:I={},localUserId:T=null,isGroup:q=!1}){const[H,et]=y.useState(null),[tt,V]=y.useState(null),[it,U]=y.useState(!K),[G,g]=y.useState(!!B),[M,Q]=y.useState(()=>typeof window<"u"?window.innerWidth>768:!0),[E,at]=y.useState(!1),s=_t(a=>a.session?.user),m=y.useRef(!1),l=y.useRef(!1),b=y.useMemo(()=>s?.avatarUrl??null,[s?.avatarUrl]),S=y.useCallback(a=>{if(m.current||(m.current=!0),a?.manual&&(l.current=!0),f&&q){try{Pt(f)}catch(c){console.error("Error leaving call room:",c)}try{At([f])}catch(c){console.error("Error requesting call status update:",c)}}const u=l.current?{...a??{},manual:!0}:a;_(u)},[f,q,_]),h=`
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
  `;if(y.useEffect(()=>{let a=!0;async function u(){if(!v||!f)return;const c=`conv-${f}`,x=await Dt.post("/livekit/token",{room:c,participantMetadata:{app:"eblusha",userId:s?.id,displayName:s?.displayName??s?.username,avatarUrl:b}});if(a){et(x.data.token),V(x.data.url);try{const r=String(x.data.token||"").split(".");if(r.length>=2){const o=r[1].replace(/-/g,"+").replace(/_/g,"/"),N=JSON.parse(atob(o)),n=!!N?.video?.canPublishData||!!N?.video?.can_publish_data;dt("lk-debug-ping","lkDebugPing")&&console.log("[Ping] LiveKit grant canPublishData:",n)}}catch{}}}return u(),()=>{a=!1,et(null),V(null)}},[v,f]),y.useEffect(()=>{v&&(g(!!B),U(!K),at(!1))},[v,B,K]),y.useEffect(()=>{if(!v)return;if(typeof window<"u"&&window.innerWidth<=768){const u=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=u}}},[v]),y.useEffect(()=>{v||(m.current=!1,l.current=!1)},[v]),y.useEffect(()=>{const a=()=>Q(typeof window<"u"?window.innerWidth>768:!0);return window.addEventListener("resize",a),()=>window.removeEventListener("resize",a)},[]),y.useEffect(()=>{if(!v)return;const a=document.body;if(!a)return;const u=()=>{const o=new Set;document.querySelectorAll(".call-container [aria-label], .call-container [title]").forEach(n=>o.add(n)),document.querySelectorAll(".call-container .lk-control-bar button, .call-container button.lk-button").forEach(n=>o.add(n)),o.forEach(n=>{const k=n.getAttribute("aria-label")||n.getAttribute("title")||"";let d="";const t=k.toLowerCase();if(t.includes("microphone")?d=k.includes("mute")?"Выключить микрофон":"Включить микрофон":t.includes("camera")?d=k.includes("disable")||t.includes("off")?"Выключить камеру":"Включить камеру":t.includes("screen")?d=t.includes("stop")?"Остановить показ экрана":"Поделиться экраном":t.includes("flip")?d="Сменить камеру":t.includes("participants")?d="Участники":t.includes("settings")?d="Настройки":t.includes("leave")||t.includes("hang")?d="Выйти":t.includes("chat")&&(d="Чат"),d&&(n.setAttribute("aria-label",d),n.setAttribute("title",d)),n.tagName==="BUTTON"){const p=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let $=p.nextNode();for(;$;){const w=($.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();let L=null;w==="leave"?L="Выйти":w==="participants"?L="Участники":w==="settings"?L="Настройки":w==="microphone"?L="Микрофон":w==="camera"?L="Камера":w==="connecting"?L="Подключение":w==="reconnecting"?L="Переподключение":w==="disconnected"?L="Отключено":(w==="screen share"||w==="share screen"||w==="share-screen"||w==="share-screen "||w.includes("share")&&w.includes("screen"))&&(L="Показ экрана"),L&&($.nodeValue=L,n.setAttribute("aria-label",L),n.setAttribute("title",L)),$=p.nextNode()}}}),document.querySelectorAll(".call-container .lk-toast-connection-state").forEach(n=>{const k=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let d=k.nextNode();for(;d;){const p=(d.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();p==="connecting"?d.nodeValue="Подключение":p==="reconnecting"?d.nodeValue="Переподключение":p==="disconnected"&&(d.nodeValue="Отключено"),d=k.nextNode()}});const N=a.querySelector(".call-container .lk-control-bar")||a.querySelector(".call-container [data-lk-control-bar]")||a.querySelector('.call-container [role="toolbar"]');if(N&&O){let n=N.querySelector(".eb-minimize-btn");if(!n){if(n=document.createElement("button"),n.className="eb-minimize-btn lk-button",n.setAttribute("aria-label","Свернуть"),n.setAttribute("title","Свернуть"),n.setAttribute("type","button"),n.innerHTML=`
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
          `,!n.__ebMinBound){n.__ebMinBound=!0;const d=t=>{t.preventDefault(),t.stopPropagation();try{O?.()}catch(p){console.error("Minimize click error",p)}};n.__ebMinHandler=d,n.addEventListener("click",d,!0),n.addEventListener("pointerup",d,!0),n.addEventListener("touchend",d,!0),n.addEventListener("keydown",t=>{t?.key!=="Enter"&&t?.key!==" "||d(t)})}n.style.pointerEvents="auto",n.disabled=!1;let k=N.querySelector("button.lk-disconnect-button")||N.querySelector('[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]');if(k&&k.parentNode){if(!k.__ebLeaveBound){const d=t=>{l.current=!0};k.addEventListener("click",d,!0),k.__ebLeaveBound=d}k.parentNode.insertBefore(n,k)}else N.appendChild(n)}if(n){const k=`
            <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
              <g id="IconSvg_bgCarrier" stroke-width="0"></g>
              <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
              <g id="IconSvg_iconCarrier">
                <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
              </g>
            </svg>`,d=`
            <span style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px; font-family: inherit; font-weight: 500; line-height: 20px;">Свернуть</span>
              ${k}
            </span>`;n.innerHTML=M?d:k,n.style.height="44px",n.style.minHeight="44px",n.style.padding="0 12px",n.style.display="flex",n.style.alignItems="center",n.style.justifyContent="flex-start",n.style.fontFamily="inherit",n.style.fontSize="14px",n.style.fontWeight="500",n.style.lineHeight="20px",n.style.pointerEvents="auto",n.disabled=!1,n.style.marginLeft="auto",n.parentElement===N&&N.lastElementChild!==n&&N.appendChild(n)}}};let c=!1;const x=()=>{c||(c=!0,requestAnimationFrame(()=>{c=!1,u()}))},r=new MutationObserver(()=>x());return r.observe(a,{childList:!0,subtree:!0,attributes:!0}),u(),()=>{r.disconnect();const o=a.querySelector(".call-container .lk-control-bar button.lk-disconnect-button")||a.querySelector('.call-container .lk-control-bar [aria-label*="Выйти" i], .call-container .lk-control-bar [title*="Выйти" i], .call-container .lk-control-bar [aria-label*="leave" i], .call-container .lk-control-bar [title*="leave" i]');o&&o.__ebLeaveBound&&(o.removeEventListener("click",o.__ebLeaveBound,!0),delete o.__ebLeaveBound)}},[v,O,S,M]),y.useEffect(()=>{if(!v)return;const a=document.body;if(!a)return;const u=T||null,c=()=>{a.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(o=>{const N=o.getAttribute("data-lk-local-participant")==="true"||o.dataset?.lkLocalParticipant==="true";let n=o.getAttribute("data-lk-participant-identity")||"";if(!n){const w=o.querySelector("[data-lk-participant-identity]");w&&(n=w.getAttribute("data-lk-participant-identity")||"")}if(!(N||!!(n&&u&&n===u)))return;const t=o.querySelector(".lk-participant-name, [data-lk-participant-name]");if(!t)return;const p=t.textContent||"",$=p.replace(/\s*\(мы\)\s*$/,"").trim();if(!$)return;const i=`${$} (мы)`;p!==i&&(t.textContent=i,t.hasAttribute("data-lk-participant-name")&&t.setAttribute("data-lk-participant-name",i))})};c();const x=new MutationObserver(()=>{setTimeout(c,50)});return x.observe(a,{childList:!0,subtree:!0,characterData:!0}),()=>x.disconnect()},[v,T]),y.useEffect(()=>{if(!v)return;const a=document.body;if(!a)return;const u=X||{},c=I||{},x=T||null,r=b||null,o=dt("lk-debug-avatars","lkDebugAvatars"),N=t=>{let p=0;for(let i=0;i<t.length;i++)p=t.charCodeAt(i)+((p<<5)-p);return`hsl(${Math.abs(p)%360} 70% 45%)`},n=(t,p)=>{const $=N(p),i=t.trim().charAt(0).toUpperCase(),w=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs/><rect width="256" height="256" rx="128" fill="${$}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="140" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" fill="#ffffff">${i}</text></svg>`;return`data:image/svg+xml;utf8,${encodeURIComponent(w)}`},k=()=>{a.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(p=>{const $=p.querySelector(".lk-participant-name, [data-lk-participant-name]"),i=p.querySelector(".lk-participant-placeholder");if(!$||!i)return;const w=p.querySelector("video.lk-participant-media-video")||p.querySelector("video"),Y=!!(!(p.getAttribute("data-video-muted")==="true"||p.getAttribute("data-lk-video-muted")==="true"||p.dataset?.videoMuted==="true"||p.dataset?.lkVideoMuted==="true")&&w&&w.offsetWidth>0&&w.offsetHeight>0);if(p.setAttribute("data-eb-has-video",Y?"true":"false"),Y){i.style.position="",i.style.inset="",i.style.left="",i.style.top="",i.style.right="",i.style.bottom="",i.style.transform="",i.style.width="",i.style.height="",i.style.maxWidth="",i.style.maxHeight="",i.style.minWidth="",i.style.minHeight="",i.style.margin="";return}let D="";const z={};for(let F=0;F<p.attributes.length;F++){const ot=p.attributes[F];ot.name.startsWith("data-")&&(z[ot.name]=ot.value)}const Z=p.getAttribute("data-lk-participant-identity");if(Z&&(D=Z.trim()),!D){const F=p.querySelector("[data-lk-participant-identity]");F&&(D=(F.getAttribute("data-lk-participant-identity")||"").trim())}if(!D){const F=p.dataset?.lkParticipantIdentity||p.dataset?.lkParticipantIdentity;F&&(D=String(F).trim())}if(!D){const F=["data-participant-identity","data-identity","data-participant-id","data-user-id"];for(const ot of F){const bt=p.getAttribute(ot);if(bt){D=bt.trim();break}}}const R=p.getAttribute("data-lk-participant-metadata")||(p.dataset?p.dataset.lkParticipantMetadata:"")||"";let A=null;if(R)try{A=JSON.parse(R)}catch{A=null}A?.userId&&(D=String(A.userId).trim());let j=($.textContent||$.getAttribute("data-lk-participant-name")||"").trim();const rt=j.replace(/\s*\(мы\)\s*$/,"").trim();if(!j&&A?.displayName&&(j=String(A.displayName).trim()),!j){const F=p.querySelector(".lk-participant-metadata");F?.textContent?.trim()&&(j=F.textContent.trim())}j||(j=D||"");const lt=!!(D&&x&&D===x),vt=D?c[D]??null:null,pt=rt||j.replace(/\s*\(мы\)\s*$/,"").trim(),mt=Object.keys(u).find(F=>F.toLowerCase()===pt.toLowerCase()),Nt=mt?u[mt]:null;let ft=vt??Nt??(lt?r||(x?c[x]??null:null):null);const ct=n(pt||D||"U",D||pt||"U");if(o&&!ft&&(D||j)){const F=Object.keys(u),ot=j?F.find(bt=>bt.toLowerCase()===j.toLowerCase()):null;console.log("[Avatars] Avatar not found:",{identity:D||"(empty)",name:j||"(empty)",isLocal:lt,localIdRef:x||"(empty)",byIdHasIdentity:D?D in c:!1,byNameHasName:!!ot,nameMatch:ot||"(no match)",participantMeta:A?{userId:A.userId,displayName:A.displayName}:null})}i.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(F=>F.remove()),i.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(F=>F.style.display="none");let W=i.querySelector("img.eb-ph");W||(W=document.createElement("img"),W.className="eb-ph",i.appendChild(W),W.onerror=()=>{W&&W.src!==ct&&(o&&console.log("[Avatars] Avatar image failed to load, using fallback:",W.src),W.src=ct)}),W.src!==(ft||ct)&&(W.src=ft||ct);const gt=p.getBoundingClientRect(),kt=Math.min(gt.width,gt.height),nt=Math.floor(kt*.95);i.style.position="absolute",i.style.inset="auto",i.style.left="50%",i.style.top="50%",i.style.right="auto",i.style.bottom="auto",i.style.transform="translate(-50%, -50%)",i.style.width=`${nt}px`,i.style.height=`${nt}px`,i.style.maxWidth=`${nt}px`,i.style.maxHeight=`${nt}px`,i.style.minWidth=`${nt}px`,i.style.minHeight=`${nt}px`,i.style.flexShrink="0",i.style.display="flex",i.style.alignItems="center",i.style.justifyContent="center",i.style.background="transparent",i.style.backgroundImage="none",i.style.color="transparent",i.style.fontSize="0",i.style.overflow="hidden",i.style.margin="0",i.style.borderRadius="50%",i.style.aspectRatio="1",W.alt=j,W.style.aspectRatio="1",W.style.width="80%",W.style.height="80%",W.style.maxWidth="80%",W.style.maxHeight="80%",W.style.objectFit="cover",W.style.borderRadius="50%",W.style.display="block",W.style.margin="auto",Array.from(i.childNodes).forEach(F=>{F.nodeType===Node.TEXT_NODE&&(F.textContent="")})})},d=new MutationObserver(k);return d.observe(a,{childList:!0,subtree:!0}),k(),()=>d.disconnect()},[v,X,I,T,b]),!v||!f||!H||!tt)return null;const e=C.jsx("div",{className:"call-overlay",onClick:a=>{a.stopPropagation()},onTouchStart:a=>{a.stopPropagation()},style:{position:"fixed",inset:0,background:P?"transparent":"rgba(10,12,16,0.55)",backdropFilter:P?"none":"blur(4px) saturate(110%)",display:P?"none":M?"flex":"block",alignItems:M?"center":void 0,justifyContent:M?"center":void 0,zIndex:1e3,pointerEvents:P?"none":"auto"},children:C.jsxs("div",{"data-lk-theme":"default",style:{width:P?0:M?"90vw":"100vw",height:P?0:M?"80vh":"100vh",minHeight:P?0:M?void 0:"100dvh",maxWidth:P?0:M?1200:"100vw",background:"var(--surface-200)",borderRadius:M?16:0,overflow:"hidden",position:"relative",border:M?"1px solid var(--surface-border)":"none",boxShadow:P?"none":M?"var(--shadow-sharp)":"none",opacity:P?0:1,visibility:P?"hidden":"visible"},className:"call-container",children:[C.jsx("style",{children:h}),C.jsx(It,{serverUrl:tt,token:H,connect:!0,video:G,audio:!it,onConnected:()=>{at(!0);try{f&&q&&(dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] joinCallRoom emit",{conversationId:f,video:B}),jt(f,B),At([f]))}catch(a){console.error("Error joining call room:",a)}},onDisconnected:a=>{dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] onDisconnected:",a,"wasConnected:",E,"isGroup:",q,"minimized:",P);const u=E;at(!1);const c=a===1||l.current;P||(q?u&&c&&S({manual:!0}):c&&S({manual:!0}))},children:C.jsxs("div",{style:{width:"100%",height:"100%"},children:[C.jsx(zt,{}),C.jsx(Ht,{}),C.jsx(Ut,{localUserId:T}),C.jsx(Kt,{}),C.jsx(qt,{SettingsComponent:Vt})]})})]})});return Lt.createPortal(e,document.body)}export{ee as CallOverlay};
