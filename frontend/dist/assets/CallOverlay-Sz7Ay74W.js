import{r as y,j as T}from"./vendor-query-CNP5Hy5J.js";import{u as _t,P as Pt,m as Nt,e as Lt,d as Dt,M as jt}from"./index-g7jd-lEN.js";import{W as It,a as qt,t as Ft,C as xt,u as yt,O as Tt,R as ht,f as wt,T as Mt,b as Bt,s as Ot,L as Wt}from"./index-BRAGuiMP.js";import{X as $t}from"./ChatsPage-BbWo9exr.js";import"./vendor-react-BcTlWpV0.js";import"./vendor-socket-CA1CrNgP.js";import"./vendor-crypto-GGjuBpPe.js";if(typeof window<"u"&&typeof navigator<"u"&&navigator.mediaDevices&&!window.__eblushaEnumeratePatched){const k=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=>{const f=await k(),P=navigator.userAgent||"";if(!/iP(ad|hone|od)/i.test(P))return f;const _=[],B=[],K=[],J=(I,A)=>{const q=I.toLowerCase();return/(front|перед|selfie|true depth|ultra wide front)/.test(q)?"front":/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(q)||/(back|rear)/.test(A.toLowerCase())?"back":"other"};f.forEach(I=>{if(I.kind!=="videoinput"){K.push(I);return}const A=J(I.label||"",I.deviceId||"");A==="front"?_.push(I):B.push(I)});const X=[];if(_.length>0&&X.push(_[0]),B.length>0&&X.push(B[0]),X.length===0&&f.some(I=>I.kind==="videoinput")){const I=f.find(A=>A.kind==="videoinput");I&&X.push(I)}return K.forEach(I=>{I.kind!=="videoinput"&&X.push(I)}),X},window.__eblushaEnumeratePatched=!0}try{Ot(Wt.warn)}catch{}const ut={aec:"eb.lk.webrtc.aec",ns:"eb.lk.webrtc.ns",agc:"eb.lk.webrtc.agc"};function St(k,f){if(typeof window>"u")return f;try{const P=window.localStorage.getItem(k);return P===null?f:P==="1"||P==="true"}catch{return f}}function Rt(k,f){if(!(typeof window>"u"))try{window.localStorage.setItem(k,f?"1":"0")}catch{}}function dt(k,f){if(typeof window>"u")return!1;try{const O=new URLSearchParams(window.location.search).get(f);if(O==="1"||O==="true")return!0;const _=window.localStorage.getItem(k);return _==="1"||_==="true"}catch{return!1}}function Ct({label:k,description:f,checked:P,onChange:O,disabled:_=!1,rightHint:B}){return T.jsxs("div",{className:"eb-toggle-row",children:[T.jsxs("div",{className:"eb-toggle-text",children:[T.jsx("div",{className:"eb-toggle-label",children:k}),f?T.jsx("div",{className:"eb-toggle-desc",children:f}):null]}),T.jsxs("div",{className:"eb-toggle-right",children:[B?T.jsx("div",{className:"eb-toggle-hint",children:B}):null,T.jsxs("label",{className:`eb-switch ${_?"is-disabled":""}`,children:[T.jsx("input",{type:"checkbox",checked:P,disabled:_,onChange:K=>O(K.target.checked)}),T.jsx("span",{className:"eb-switch-track","aria-hidden":"true"})]})]})]})}function zt(){const k=Ft();let f="Подключено";return k===xt.Connecting?f="Подключение…":k===xt.Reconnecting?f="Переподключение…":k===xt.Disconnected&&(f="Отключено"),T.jsx("div",{className:"eb-conn-badge",style:{position:"absolute",top:10,left:10,zIndex:20,padding:"6px 10px",borderRadius:999,background:"rgba(0,0,0,0.45)",border:"1px solid rgba(255,255,255,0.12)",fontSize:12,color:"#fff",backdropFilter:"blur(6px)"},children:f})}function Ht(){const k=yt(),{isMicrophoneEnabled:f}=Tt(),P=y.useRef(!1);return y.useEffect(()=>{k&&(P.current||f&&(P.current=!0,k.localParticipant.setMicrophoneEnabled(!0,{deviceId:"default"}).catch(O=>console.warn("[DefaultMicrophoneSetter] Failed to set default microphone",O))))},[k,f]),null}function Ut({localUserId:k}){const f=yt(),{localParticipant:P,microphoneTrack:O,cameraTrack:_}=Tt(),[B,K]=y.useState(null),J=y.useRef(null),[X,I]=y.useState(null),A=y.useRef(null),q=y.useRef(null),H=y.useRef(new Map),et=y.useRef(new Map),tt=y.useRef(0),V=y.useRef(!1),it=y.useRef(!1),U=y.useRef(0),G=y.useRef({at:0,rtt:null}),[g,M]=y.useState(()=>dt("lk-debug-ping","lkDebugPing")),Q=y.useRef({at:0,lastLocalRtt:null,lastSignalRtt:null}),E=(...m)=>{g&&console.log("[Ping]",...m)};y.useEffect(()=>{const m=window.setInterval(()=>{const l=dt("lk-debug-ping","lkDebugPing");M(h=>h===l?h:l)},1e3);return()=>window.clearInterval(m)},[]),y.useEffect(()=>{if(g){E("debug enabled",{localStorage:(()=>{try{return window.localStorage.getItem("lk-debug-ping")}catch{return"(unavailable)"}})(),query:(()=>{try{return new URLSearchParams(window.location.search).get("lkDebugPing")}catch{return"(unavailable)"}})(),localIdentity:P?.identity??null});try{const l=performance?.getEntriesByType?.("resource")?.map(h=>h.name).find(h=>h.includes("/assets/CallOverlay-"))??null;l&&E("asset",l)}catch{}}},[g,P?.identity]),y.useEffect(()=>{A.current=X,q.current?.(),g&&E("localPlayoutMs state",X)},[X]),y.useEffect(()=>{if(!f)return;const m=b=>{let e=null;try{b.forEach(r=>{if(r?.type!=="inbound-rtp")return;const u=(r?.kind||r?.mediaType||"").toString().toLowerCase();if(u&&u!=="audio")return;const c=typeof r?.jitterBufferTargetDelay=="number"?r.jitterBufferTargetDelay:null;if(typeof c=="number"&&Number.isFinite(c)&&c>0){const o=c*1e3;Number.isFinite(o)&&o>0&&o<5e3&&(e=e===null?o:Math.max(e,o))}const v=typeof r?.jitterBufferDelay=="number"?r.jitterBufferDelay:null,i=typeof r?.jitterBufferEmittedCount=="number"?r.jitterBufferEmittedCount:null;if(typeof v=="number"&&typeof i=="number"&&Number.isFinite(v)&&Number.isFinite(i)&&v>0&&i>=50){const o=v/i*1e3;Number.isFinite(o)&&o>0&&o<5e3&&(e=e===null?o:Math.max(e,o))}})}catch{}return e};let l=!1;const h=async()=>{try{const e=f.engine?.pcManager?.subscriber;if(e?.getStats){const r=await e.getStats(),u=m(r);l||I(u),g&&E("playout sample",{ms:u});return}}catch(b){g&&E("playout sample failed",b)}l||I(null)},R=window.setInterval(h,2e3);return h(),()=>{l=!0,window.clearInterval(R)}},[f,g]);const at=m=>m.getAttribute("data-lk-local-participant")==="true"?!0:m.dataset?.lkLocalParticipant==="true",s=m=>{const l=m.querySelector("[data-lk-participant-name]")||m.querySelector(".lk-participant-name"),h=l?.getAttribute("data-lk-participant-name"),R=h&&h.trim()||(l?.textContent?.trim()??"");return R?R.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null};return y.useEffect(()=>{if(!f||!P)return;const m=b=>{try{let e=null;const r=i=>{const o=(typeof i?.currentRoundTripTime=="number"?i.currentRoundTripTime:null)??(typeof i?.roundTripTime=="number"?i.roundTripTime:null)??(typeof i?.totalRoundTripTime=="number"&&Number.isFinite(i.totalRoundTripTime)&&i.totalRoundTripTime>0&&typeof i?.responsesReceived=="number"&&Number.isFinite(i.responsesReceived)&&i.responsesReceived>0?i.totalRoundTripTime/i.responsesReceived:null);return typeof o!="number"||!Number.isFinite(o)||o<=0?null:o};let u=null,c=null;b.forEach(i=>{i?.type==="transport"&&i.selectedCandidatePairId&&(u=String(i.selectedCandidatePairId))}),u&&(c=b.get?.(u)??(()=>{let i=null;return b.forEach(o=>{i||o?.id===u&&(i=o)}),i})()??null),c||b.forEach(i=>{c||i?.type==="candidate-pair"&&(i.selected||i.nominated||i.state==="succeeded")&&(c=i)});const v=c?r(c):null;if(typeof v=="number"&&Number.isFinite(v)&&v>0&&(e=v),b.forEach(i=>{if(i?.type!=="candidate-pair"||!(i.selected||i.nominated||i.state==="succeeded"))return;const o=r(i);typeof o=="number"&&(e===null||o<e)&&(e=o)}),b.forEach(i=>{if(i?.type!=="remote-inbound-rtp")return;const o=(typeof i?.roundTripTime=="number"?i.roundTripTime:null)??(typeof i?.totalRoundTripTime=="number"&&Number.isFinite(i.totalRoundTripTime)&&i.totalRoundTripTime>0&&typeof i?.roundTripTimeMeasurements=="number"&&Number.isFinite(i.roundTripTimeMeasurements)&&i.roundTripTimeMeasurements>0?i.totalRoundTripTime/i.roundTripTimeMeasurements:null);typeof o!="number"||!Number.isFinite(o)||o<=0||(e===null||o<e)&&(e=o)}),b.forEach(i=>{const o=typeof i?.roundTripTime=="number"?i.roundTripTime:null;typeof o!="number"||!Number.isFinite(o)||o<=0||(e===null||o<e)&&(e=o)}),typeof e=="number"&&Number.isFinite(e)&&e>0)return e*1e3}catch{}return null},l=async()=>{try{const b=f.engine,e=b?.client?.rtt;if((!e||e<=0)&&typeof b?.client?.sendPing=="function"){const n=Date.now();if(n-U.current>5e3){U.current=n;try{await b.client.sendPing(),g&&E("signal sendPing() called")}catch(x){g&&E("signal sendPing() failed",x)}}}if(g){const n=Date.now(),x=Q.current;(typeof e=="number"?e:null)!==x.lastSignalRtt&&n-x.at>750&&(Q.current={...x,at:n,lastSignalRtt:typeof e=="number"?e:null},E("signal rtt",{rtt:e,hasEngine:!!b,localIdentity:P.identity}))}if(typeof e=="number"&&Number.isFinite(e)&&e>0){K(e),g&&E("local rtt set",{ms:Math.round(e),source:"engine.client.rtt"});return}const r=O?.track;if(r&&typeof r.getSenderStats=="function")try{const n=await r.getSenderStats(),x=typeof n?.roundTripTime=="number"?n.roundTripTime:null;if(typeof x=="number"&&Number.isFinite(x)&&x>0){const d=x*1e3;K(d),g&&E("local rtt set",{ms:Math.round(d),source:"LocalAudioTrack.getSenderStats().roundTripTime"});return}}catch(n){g&&E("mic getSenderStats failed",n)}const u=_?.track;if(u&&typeof u.getSenderStats=="function")try{const n=await u.getSenderStats(),d=(Array.isArray(n)?n:[]).map(t=>typeof t?.roundTripTime=="number"?t.roundTripTime:null).filter(t=>typeof t=="number"&&Number.isFinite(t)&&t>0);if(d.length>0){const p=Math.min(...d)*1e3;K(p),g&&E("local rtt set",{ms:Math.round(p),source:"LocalVideoTrack.getSenderStats()[].roundTripTime"});return}}catch(n){g&&E("camera getSenderStats failed",n)}const c=Date.now();if(c-tt.current<3e3)return;const v=b?.pcManager?.publisher,i=b?.pcManager?.subscriber,o=[v,i].filter(Boolean),S=[O?.track,_?.track].filter(Boolean);if(o.length>0||S.length>0)tt.current=c;else{g&&!it.current&&(it.current=!0,E("waiting for transports/tracks",{publisher:!!v,subscriber:!!i,trackCandidates:S.length}));return}for(const n of o){if(!n?.getStats)continue;const x=await n.getStats(),d=m(x);if(typeof d=="number"&&Number.isFinite(d)&&d>0){K(d),g&&E("local rtt set",{ms:Math.round(d),source:"pcTransport.getStats()"});return}}for(const n of S){if(!n?.getRTCStatsReport)continue;const x=await n.getRTCStatsReport();if(!x)continue;const d=m(x);if(typeof d=="number"&&Number.isFinite(d)&&d>0){K(d),g&&E("local rtt set",{ms:Math.round(d),source:"MediaStreamTrack.getRTCStatsReport()"});return}}V.current||(V.current=!0,g&&E("could not compute local rtt",{signalRtt:e,transports:o.length,trackCandidates:S.length,localIdentity:P.identity}))}catch(b){g&&E("updateRtt error",b)}},h=setInterval(()=>void l(),1500);l();const R=setTimeout(()=>void l(),2500);return()=>{clearInterval(h),clearTimeout(R)}},[f,P,O?.trackSid,_?.trackSid]),y.useEffect(()=>{if(!f||!P)return;const m=new TextEncoder,l=async()=>{try{const e=J.current;if(typeof e!="number"||!Number.isFinite(e)||e<=0){g&&E("skip publish eb.ping (no local rtt yet)",{localRtt:e});return}const r=Date.now(),u=G.current,c=u.rtt===null||Math.abs(u.rtt-e)>=2;if(!(r-u.at>=2e3)&&!c)return;G.current={at:r,rtt:e};const i=A.current,o={t:"eb.ping",v:2,rtt:Math.round(e),playoutMs:typeof i=="number"&&Number.isFinite(i)&&i>=0?Math.round(i):0,ts:r};await P.publishData(m.encode(JSON.stringify(o)),{reliable:!1,topic:"eb.ping"}),g&&E("publish eb.ping ok",o)}catch(e){g&&E("publish eb.ping failed",e),g&&!window.__ebPingPublishWarned&&(window.__ebPingPublishWarned=!0,console.warn("[Ping] Failed to publish eb.ping (data channel). Check LiveKit token grant canPublishData=true."))}},h=new TextDecoder,R=(e,r,u,c)=>{if(c&&c!=="eb.ping")return;const v=r?.identity;if(v&&!(P&&v===P.identity))try{const i=JSON.parse(h.decode(e));if(!i||i.t!=="eb.ping")return;const o=Number(i.rtt);if(!Number.isFinite(o)||o<=0)return;const S=Number(i.playoutMs),n=Number.isFinite(S)&&S>=0?S:0,x=typeof r?.name=="string"&&r.name?r.name:null,d=H.current.get(v);H.current.set(v,o),x&&H.current.set(x,o),et.current.set(v,n),x&&et.current.set(x,n);const t=typeof r?.metadata=="string"?r.metadata:null;if(t)try{const p=JSON.parse(t);p?.displayName&&H.current.set(String(p.displayName),o),p?.userId&&H.current.set(String(p.userId),o),p?.displayName&&et.current.set(String(p.displayName),n),p?.userId&&et.current.set(String(p.userId),n)}catch{}g&&(d===void 0||Math.abs(d-o)>=2)&&E("recv eb.ping",{from:v,name:x,rtt:o,playoutMs:n,ts:i.ts,topic:c??null}),q.current?.()}catch{}};f.on(ht.DataReceived,R);const b=setInterval(()=>void l(),2e3);return l(),()=>{clearInterval(b),f.off(ht.DataReceived,R)}},[f,P,g]),y.useEffect(()=>{J.current=B,q.current?.(),g&&E("localRtt state",B)},[B]),y.useEffect(()=>{if(!f)return;const m=document.querySelector(".call-container");if(!m)return;const l=r=>{const u=J.current;return typeof u!="number"||!Number.isFinite(u)||u<=0?"—":r?`${Math.round(u)} мс`:"—"},h=()=>{const r=m.querySelectorAll(".lk-participant-metadata-item[data-lk-quality]");g&&E("dom scan",{indicators:r.length}),r.forEach(u=>{const c=u.closest(".lk-participant-tile, [data-participant]");if(!c)return;const v=at(c),i=s(c);u.classList.contains("eb-ping-display")||u.classList.add("eb-ping-display");let o=u.querySelector(".eb-ping-text");o||(o=document.createElement("span"),o.className="eb-ping-text",u.appendChild(o));let S=null,n=l(v);if(v){const t=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&(S=Math.round(t),n=`${S} мс`)}else{const t=(i?H.current.get(i):void 0)??void 0,p=(i?et.current.get(i):void 0)??0,$=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&typeof $=="number"&&$>0&&(S=Math.round((t+$)/2+(typeof p=="number"&&Number.isFinite(p)&&p>=0?p:0)),n=`${S} мс`)}const x=typeof S=="number"&&Number.isFinite(S)&&S>0;if(u.classList.toggle("eb-ping-has-value",x),typeof S=="number"&&Number.isFinite(S)&&S>0){const t=S<=200?"good":S<=500?"warn":"bad";u.setAttribute("data-eb-ping-level",t)}else u.removeAttribute("data-eb-ping-level");const d=x?n:"";if(o.textContent!==d&&(o.textContent=d,g)){const t=J.current,p=i?H.current.get(i):void 0;E("dom set",{name:i,isLocal:v,text:d,mine:t,remote:p})}})};let R=!1;const b=()=>{R||(R=!0,requestAnimationFrame(()=>{R=!1,h()}))};q.current=b;const e=new MutationObserver(()=>b());return e.observe(m,{childList:!0,subtree:!0}),b(),()=>{q.current===b&&(q.current=null),e.disconnect()}},[f,P,k,g]),null}function Kt(){const k=yt(),f=y.useRef(null),P=y.useRef(new Map),O=y.useRef(0),_=y.useRef(new WeakMap),B=y.useRef(new Map),K=s=>s.getAttribute("data-lk-local-participant")==="true"?!0:s.dataset?.lkLocalParticipant==="true",J=s=>{const m=s.querySelector("[data-lk-participant-name]")||s.querySelector(".lk-participant-name"),l=m?.getAttribute("data-lk-participant-name"),h=l&&l.trim()||(m?.textContent?.trim()??"");return h?h.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null},X=s=>{const m=s.getAttribute("data-lk-participant-identity")||s.getAttribute("data-participant-identity")||s.getAttribute("data-user-id")||s.dataset?.lkParticipantIdentity||"",l=String(m||"").trim();if(l)return l;const h=s.getAttribute("data-lk-participant-metadata")||(s.dataset?s.dataset.lkParticipantMetadata:"")||"";if(h)try{const R=JSON.parse(h);if(R?.userId)return String(R.userId).trim()}catch{}return null},I=s=>{const m=X(s),l=J(s),h=m||l;return h?{key:h,userId:m,name:l}:null},A=s=>{const m=P.current,l=m.get(s);if(l)return l;const h={volume:1,muted:!1,lastNonZeroPct:100};return m.set(s,h),h},q=async()=>{if(O.current=Date.now(),f.current){try{f.current.state!=="running"&&await f.current.resume()}catch{}return f.current}try{const s=new(window.AudioContext||window.webkitAudioContext);f.current=s;try{s.state!=="running"&&await s.resume()}catch{}return s}catch{return null}},H=s=>{const m=s?.metadata;if(!m||typeof m!="string")return null;try{const l=JSON.parse(m);if(!l||typeof l!="object")return null;const h=l.userId?String(l.userId):void 0,R=l.displayName?String(l.displayName):void 0;return{userId:h,displayName:R}}catch{return null}},et=s=>{if(!k)return null;const m=(s.userId?k.remoteParticipants.get(s.userId):null)||k.remoteParticipants.get(s.key)||null;if(m)return m;const l=(s.name||"").trim(),h=(s.key||"").trim(),R=(s.userId||"").trim();for(const b of k.remoteParticipants.values())try{if(R&&String(b.identity)===R||h&&String(b.identity)===h||l&&String(b.name||"").trim()===l)return b;const e=H(b);if(R&&e?.userId&&e.userId===R||l&&e?.displayName&&e.displayName.trim()===l)return b}catch{}return null},tt=async(s,m)=>{if(!k)return;const{key:l}=s,h=et(s);if(!h)return;const R=A(l),b=R.muted?0:R.volume,e=b>1,r=f.current||(e&&m?await q():null),u=[];try{const c=h.trackPublications;if(c?.values)for(const v of c.values())u.push(v)}catch{}for(const c of u){if(c?.kind!==Mt.Kind.Audio)continue;if(typeof c?.setEnabled=="function")try{c.setEnabled(!R.muted&&b>0)}catch{}const v=c?.track;if(!(v instanceof Bt))continue;const i=_.current.get(v);if(e&&r){(!i||i.ctx!==r||!i.enabled)&&(v.setAudioContext(r),_.current.set(v,{ctx:r,enabled:!0}));try{v.attachedElements.forEach(S=>{try{S.volume=0,S.muted=!0}catch{}})}catch{}}else{if(i?.enabled){try{v.setAudioContext(void 0)}catch{}_.current.set(v,{ctx:i.ctx,enabled:!1})}try{const S=R.muted||b<=0;v.attachedElements.forEach(n=>{try{n.muted=S}catch{}})}catch{}}const o=R.muted?0:Math.max(0,Math.min(e?1.5:1,b));v.setVolume(o)}};y.useEffect(()=>{if(!k)return;const s=(m,l,h)=>{try{const R=String(h?.identity||""),b=String(h?.name||""),e=R||b;if(!e||h?.isLocal)return;P.current.has(e)&&m?.kind===Mt.Kind.Audio&&tt({key:e,userId:R||null,name:b||null},!1)}catch{}};return k.on(ht.TrackSubscribed,s),()=>{k.off(ht.TrackSubscribed,s)}},[k]);const V=150,it=100,U=105,G=2*Math.PI*U,g=s=>Math.max(0,Math.min(V,Math.round(s))),M=s=>g(s.muted?0:s.volume*100),Q=(s,m,l)=>{const h=Math.max(0,G-l);s.style.strokeDasharray=`${l} ${h}`,s.style.strokeDashoffset=`-${m}`,s.style.opacity=l>0?"1":"0"},E=(s,m,l)=>{const h=s.__ebRingSafe,R=s.__ebRingOver,b=s.__ebRingThumb,e=s.__ebRingLabel,r=s.__ebRingVal,u=s.__ebRingMuteBtn;if(!h||!R)return;const c=g(m),v=Math.min(c,it)/V,i=Math.max(c-it,0)/V,o=G*v,S=G*i;if(Q(h,0,o),Q(R,o,S),b){const x=c/V*(Math.PI*2),d=110+U*Math.cos(x),t=110+U*Math.sin(x);b.setAttribute("cx",`${d}`),b.setAttribute("cy",`${t}`),b.style.opacity="1"}r?r.textContent=`${c}%`:e&&(e.textContent=`${c}%`),u&&(u.textContent=l||c===0?"Вернуть":"Заглушить"),s.setAttribute("data-eb-over",c>it?"true":"false"),s.setAttribute("data-eb-muted",l||c===0?"true":"false")},at=(s,m)=>{const l=m.getBoundingClientRect(),h=l.left+l.width/2,R=l.top+l.height/2,b=s.clientX-h,e=s.clientY-R;let r=Math.atan2(e,b)*180/Math.PI;r=(r+90+360)%360;const u=r/360;return g(u*V)};return y.useEffect(()=>{if(!k)return;const s=document.body;if(!s)return;const m=()=>{try{s.querySelectorAll(".call-container .lk-participant-tile").forEach(e=>{if(K(e))return;const r=I(e);if(!r)return;e.setAttribute("data-eb-remote","true");const u=et(r),c=u?String(u.identity):r.key,i=(u?H(u):null)?.displayName||r.name||null,o={key:c,userId:c,name:i};e.setAttribute("data-eb-vol-key",c);const S=e.getAttribute("data-video-muted")==="true"||e.getAttribute("data-lk-video-muted")==="true"||e.dataset?.videoMuted==="true"||e.dataset?.lkVideoMuted==="true",n=e.querySelector("video.lk-participant-media-video")||e.querySelector("video");if(!!(!S&&n&&n.offsetWidth>0&&n.offsetHeight>0)){e.querySelectorAll(".eb-vol-ring").forEach(a=>a.remove());return}const d=e.querySelector(".lk-participant-placeholder");if(!d)return;e.style.position||(e.style.position="relative");let t=e.querySelector(".eb-vol-ring");if(t?t.setAttribute("data-eb-vol-key",c):(t=document.createElement("div"),t.className="eb-vol-ring",t.setAttribute("data-eb-vol-key",c),t.innerHTML=`
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
            `,e.appendChild(t)),!t.__ebRingInit){t.__ebRingInit=!0;const a=t.querySelector("svg.eb-vol-ring-svg"),w=t.querySelector("circle.safe"),L=t.querySelector("circle.over"),Y=t.querySelector("circle.thumb"),D=t.querySelector("circle.hit"),z=t.querySelector(".label"),Z=t.querySelector(".label .val"),C=t.querySelector("button.btn.mute"),N=t.querySelector("button.btn.reset");t.__ebRingSvg=a,t.__ebRingSafe=w,t.__ebRingOver=L,t.__ebRingThumb=Y,t.__ebRingHit=D,t.__ebRingLabel=z,t.__ebRingVal=Z,t.__ebRingMuteBtn=C,t.__ebRingResetBtn=N}const p=()=>{const a=A(c),w=M(a);w>0&&(a.lastNonZeroPct=w),E(t,w,!!a.muted)};try{const a=e.getBoundingClientRect(),w=e.offsetWidth||a.width||1,L=e.offsetHeight||a.height||1,Y=a.width?a.width/w:1,D=a.height?a.height/L:1,z=d.getBoundingClientRect(),C=d.querySelector("img.eb-ph")?.getBoundingClientRect(),N=C&&C.width>10?C.width:z.width*.8,j=(Y+D)/2||1,rt=N/j,st=C&&C.width>10?C.left-a.left+C.width/2:z.left-a.left+z.width/2,lt=C&&C.height>10?C.top-a.top+C.height/2:z.top-a.top+z.height/2,vt=st/Y-e.clientLeft,pt=lt/D-e.clientTop,mt=220,ft=105-10/2,ct=0,W=rt/2,gt=mt*(W+ct)/ft,kt=Math.min(Math.min(e.clientWidth||w,e.clientHeight||L)-6,gt),nt=Math.max(56,kt);nt<150?t.setAttribute("data-eb-compact","true"):t.removeAttribute("data-eb-compact"),t.style.width=`${nt}px`,t.style.height=`${nt}px`,t.style.left=`${vt}px`,t.style.top=`${pt}px`,t.style.transform="translate(-50%, -50%)"}catch{}const $=(a,w)=>{let L=g(a);const Y=String(t?.getAttribute("data-eb-vol-key")||c).trim();if(!Y)return;const D=typeof t.__ebLastPct=="number"?t.__ebLastPct:L;if(t.__ebDragging){const Z=L-D;Math.abs(Z)>V/2&&(L=D>V/2?V:0)}t.__ebLastPct=L;const z=A(Y);L===0?(z.muted=!0,z.volume=0):(z.muted=!1,z.lastNonZeroPct=L,z.volume=L/100),E(t,L,!!z.muted),tt({key:Y,userId:Y,name:null},w)};if(!t.__ebRingBound){t.__ebRingBound=!0;const a=t.__ebRingSvg,w=t.__ebRingHit,L=t.__ebRingMuteBtn,Y=t.__ebRingResetBtn;if(a&&w){w.addEventListener("pointerdown",C=>{C.preventDefault(),C.stopPropagation(),O.current=Date.now(),t.__ebDragging=!0;try{const j=String(t?.getAttribute("data-eb-vol-key")||"").trim();j&&(t.__ebLastPct=M(A(j)))}catch{}try{w.setPointerCapture?.(C.pointerId)}catch{}const N=at(C,a);$(N,!0)}),w.addEventListener("pointermove",C=>{if(!t.__ebDragging)return;C.preventDefault(),C.stopPropagation();const N=at(C,a);$(N,!0)});const Z=C=>{t.__ebDragging&&(t.__ebDragging=!1);try{w.releasePointerCapture?.(C.pointerId)}catch{}};w.addEventListener("pointerup",Z),w.addEventListener("pointercancel",Z)}const D=Z=>{Z.preventDefault(),Z.stopPropagation();const C=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!C)return;const N=A(C),j=M(N);if(N.muted||j===0){const st=g(N.lastNonZeroPct||100);N.muted=!1,N.lastNonZeroPct=Math.max(1,st),N.volume=N.lastNonZeroPct/100}else j>0&&(N.lastNonZeroPct=j),N.muted=!0,N.volume=0;const rt=M(N);t.__ebLastPct=rt,E(t,rt,!!N.muted),tt({key:C,userId:C,name:null},!0)},z=Z=>{Z.preventDefault(),Z.stopPropagation();const C=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!C)return;const N=A(C);N.muted=!1,N.lastNonZeroPct=100,N.volume=1;const j=M(N);t.__ebLastPct=j,E(t,j,!!N.muted),tt({key:C,userId:C,name:null},!0)};L?.addEventListener("click",D),Y?.addEventListener("click",z)}e.__ebVolWheelBound||(e.__ebVolWheelBound=!0,e.addEventListener("wheel",a=>{a.preventDefault(),a.stopPropagation();const w=String(e.getAttribute("data-eb-vol-key")||"").trim();if(!w)return;const L=A(w),Y=M(L),D=(a.deltaMode===1?a.deltaY*40:a.deltaMode===2?a.deltaY*(window.innerHeight||800):a.deltaY)||0,z=B.current,C=(z.get(w)||0)+D;z.set(w,C);const N=100,j=Math.trunc(Math.abs(C)/N);if(j<=0)return;const rt=j*N*Math.sign(C);z.set(w,C-rt);const st=a.shiftKey?2:1,lt=C<0?1:-1;$(Y+lt*j*st,!0)},{passive:!1})),p(),tt(o,!1)})}catch{}};let l=!1;const h=()=>{l||(l=!0,requestAnimationFrame(()=>{l=!1,m()}))},R=new MutationObserver(()=>h());return R.observe(s,{childList:!0,subtree:!0}),m(),()=>{R.disconnect()}},[k]),null}function Vt(){const k=yt(),{isMicrophoneEnabled:f,microphoneTrack:P}=Tt(),[O,_]=y.useState(()=>St(ut.aec,!0)),[B,K]=y.useState(()=>St(ut.ns,!0)),[J,X]=y.useState(()=>St(ut.agc,!0)),I=y.useRef("");return y.useEffect(()=>{if(!k||!f)return;const A=`${O}|${B}|${J}|${P?.trackSid??""}`;I.current!==A&&(I.current=A,k.localParticipant.setMicrophoneEnabled(!0,{echoCancellation:O,noiseSuppression:B,autoGainControl:J}).catch(q=>console.warn("[CallSettings] Failed to apply mic capture options",q)))},[k,f,O,B,J,P?.trackSid]),y.useEffect(()=>{const A=()=>{const et=document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li"),tt=[],V=new Map;et.forEach(U=>{const G=U.querySelector(".lk-button");if(!G)return;const g=G.textContent||"",M=/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i.test(g);let Q=g.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim();Q=Q.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),V.has(Q)||V.set(Q,[]),V.get(Q).push(U),M&&tt.push(U)}),tt.forEach(U=>{U.remove()}),document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button").forEach(U=>{const G=Array.from(U.childNodes).find(M=>M.nodeType===Node.TEXT_NODE);let g=U.querySelector("span.eb-device-label");if(G&&!g){const M=G.textContent||"";g=document.createElement("span"),g.className="eb-device-label",g.textContent=M,U.replaceChild(g,G)}if(g){let M=g.textContent||"";M=M.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim(),M=M.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),M=M.replace(/\s*\([0-9a-fA-F]{4}:\s*$/,"").trim(),M!==g.textContent&&(g.textContent=M),setTimeout(()=>{const Q=U.getBoundingClientRect(),E=g.getBoundingClientRect(),s=Q.width-24;if(E.width>s){const m=E.width-s;g.setAttribute("data-overflows","true"),g.style.setProperty("--eb-device-scroll-distance",`${-m}px`)}else g.removeAttribute("data-overflows"),g.style.removeProperty("--eb-device-scroll-distance")},10)}})};A();const q=new MutationObserver(()=>{setTimeout(A,50)}),H=document.querySelector(".call-container .lk-settings-menu-modal");if(H)return q.observe(H,{childList:!0,subtree:!0,characterData:!0}),()=>q.disconnect()},[]),T.jsxs("div",{className:"eb-call-settings",style:{width:"100%"},children:[T.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12},children:[T.jsx("div",{style:{fontSize:18,fontWeight:600},children:"Настройки"}),T.jsx("button",{type:"button",className:"btn btn-icon btn-ghost","aria-label":"Закрыть настройки",title:"Закрыть настройки",onClick:A=>{A.preventDefault(),A.stopPropagation();const q=document.querySelector(".call-container .lk-settings-toggle");if(q){q.click();return}const H=document.querySelector(".call-container .lk-settings-menu-modal");H&&(H.style.display="none")},style:{padding:8},children:T.jsx($t,{size:18})})]}),T.jsxs("div",{className:"eb-settings-section",children:[T.jsx("div",{className:"eb-section-title",children:"Обработка микрофона"}),T.jsx(Ct,{label:"WebRTC: AEC (анти-эхо)",description:"Эхо‑подавление на уровне браузера (лучше включать почти всегда).",checked:O,onChange:A=>{_(A),Rt(ut.aec,A)}}),T.jsx(Ct,{label:"WebRTC: NS (шумоподавление)",description:"Шумоподавление на уровне браузера.",checked:B,onChange:A=>{K(A),Rt(ut.ns,A)}}),T.jsx(Ct,{label:"WebRTC: AGC (автогейн)",description:"Автоматическая регулировка усиления микрофона.",checked:J,onChange:A=>{X(A),Rt(ut.agc,A)}}),T.jsx("div",{className:"eb-settings-note",children:"Изменения AEC/NS/AGC применяются перезапуском микрофона и могут дать короткий “пик” при переключении."})]}),T.jsxs("div",{className:"eb-settings-grid",style:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))",gap:16,alignItems:"start",marginBottom:12},children:[T.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[T.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Микрофон"}),T.jsx(wt,{kind:"audioinput",requestPermissions:!0})]}),T.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[T.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Камера"}),T.jsx(wt,{kind:"videoinput",requestPermissions:!0})]}),T.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[T.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Вывод звука"}),T.jsx(wt,{kind:"audiooutput",requestPermissions:!0}),T.jsx("div",{style:{fontSize:11,opacity:.65,marginTop:6},children:"На Safari/iOS переключение устройства вывода может быть недоступно."})]})]}),T.jsx("div",{style:{fontSize:12,opacity:.8},children:"Выберите устройства ввода. Закрыть это окно можно кнопкой «Настройки» внизу."})]})}function ee({open:k,conversationId:f,onClose:P,onMinimize:O,minimized:_=!1,initialVideo:B=!1,initialAudio:K=!0,peerAvatarUrl:J=null,avatarsByName:X={},avatarsById:I={},localUserId:A=null,isGroup:q=!1}){const[H,et]=y.useState(null),[tt,V]=y.useState(null),[it,U]=y.useState(!K),[G,g]=y.useState(!!B),[M,Q]=y.useState(()=>typeof window<"u"?window.innerWidth>768:!0),[E,at]=y.useState(!1),s=_t(r=>r.session?.user),m=y.useRef(!1),l=y.useRef(!1),h=y.useMemo(()=>s?.avatarUrl??null,[s?.avatarUrl]),R=y.useCallback(r=>{if(m.current||(m.current=!0),r?.manual&&(l.current=!0),f&&q){try{Pt(f)}catch(c){console.error("Error leaving call room:",c)}try{Nt([f])}catch(c){console.error("Error requesting call status update:",c)}}const u=l.current?{...r??{},manual:!0}:r;P(u)},[f,q,P]),b=`
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
  `;if(y.useEffect(()=>{let r=!0;async function u(){if(!k||!f)return;const c=`conv-${f}`,v=await Dt.post("/livekit/token",{room:c,participantMetadata:{app:"eblusha",userId:s?.id,displayName:s?.displayName??s?.username,avatarUrl:h}});if(r){et(v.data.token),V(v.data.url);try{const i=String(v.data.token||"").split(".");if(i.length>=2){const o=i[1].replace(/-/g,"+").replace(/_/g,"/"),S=JSON.parse(atob(o)),n=!!S?.video?.canPublishData||!!S?.video?.can_publish_data;dt("lk-debug-ping","lkDebugPing")&&console.log("[Ping] LiveKit grant canPublishData:",n)}}catch{}}}return u(),()=>{r=!1,et(null),V(null)}},[k,f]),y.useEffect(()=>{k&&(g(!!B),U(!K),at(!1))},[k,B,K]),y.useEffect(()=>{if(!k)return;if(typeof window<"u"&&window.innerWidth<=768){const u=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=u}}},[k]),y.useEffect(()=>{k||(m.current=!1,l.current=!1)},[k]),y.useEffect(()=>{const r=()=>Q(typeof window<"u"?window.innerWidth>768:!0);return window.addEventListener("resize",r),()=>window.removeEventListener("resize",r)},[]),y.useEffect(()=>{if(!k)return;const r=document.body;if(!r)return;const u=()=>{const o=new Set;document.querySelectorAll(".call-container [aria-label], .call-container [title]").forEach(n=>o.add(n)),document.querySelectorAll(".call-container .lk-control-bar button, .call-container button.lk-button").forEach(n=>o.add(n)),o.forEach(n=>{const x=n.getAttribute("aria-label")||n.getAttribute("title")||"";let d="";const t=x.toLowerCase();if(t.includes("microphone")?d=x.includes("mute")?"Выключить микрофон":"Включить микрофон":t.includes("camera")?d=x.includes("disable")||t.includes("off")?"Выключить камеру":"Включить камеру":t.includes("screen")?d=t.includes("stop")?"Остановить показ экрана":"Поделиться экраном":t.includes("flip")?d="Сменить камеру":t.includes("participants")?d="Участники":t.includes("settings")?d="Настройки":t.includes("leave")||t.includes("hang")?d="Выйти":t.includes("chat")&&(d="Чат"),d&&(n.setAttribute("aria-label",d),n.setAttribute("title",d)),n.tagName==="BUTTON"){const p=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let $=p.nextNode();for(;$;){const w=($.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();let L=null;w==="leave"?L="Выйти":w==="participants"?L="Участники":w==="settings"?L="Настройки":w==="microphone"?L="Микрофон":w==="camera"?L="Камера":w==="connecting"?L="Подключение":w==="reconnecting"?L="Переподключение":w==="disconnected"?L="Отключено":(w==="screen share"||w==="share screen"||w==="share-screen"||w==="share-screen "||w.includes("share")&&w.includes("screen"))&&(L="Показ экрана"),L&&($.nodeValue=L,n.setAttribute("aria-label",L),n.setAttribute("title",L)),$=p.nextNode()}}}),document.querySelectorAll(".call-container .lk-toast-connection-state").forEach(n=>{const x=document.createTreeWalker(n,NodeFilter.SHOW_TEXT);let d=x.nextNode();for(;d;){const p=(d.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();p==="connecting"?d.nodeValue="Подключение":p==="reconnecting"?d.nodeValue="Переподключение":p==="disconnected"&&(d.nodeValue="Отключено"),d=x.nextNode()}});const S=r.querySelector(".call-container .lk-control-bar")||r.querySelector(".call-container [data-lk-control-bar]")||r.querySelector('.call-container [role="toolbar"]');if(S&&O){let n=S.querySelector(".eb-minimize-btn");if(!n){if(n=document.createElement("button"),n.className="eb-minimize-btn lk-button",n.setAttribute("aria-label","Свернуть"),n.setAttribute("title","Свернуть"),n.setAttribute("type","button"),n.innerHTML=`
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
          `,!n.__ebMinBound){n.__ebMinBound=!0;const d=t=>{t.preventDefault(),t.stopPropagation();try{O?.()}catch(p){console.error("Minimize click error",p)}};n.__ebMinHandler=d,n.addEventListener("click",d,!0),n.addEventListener("pointerup",d,!0),n.addEventListener("touchend",d,!0),n.addEventListener("keydown",t=>{t?.key!=="Enter"&&t?.key!==" "||d(t)})}n.style.pointerEvents="auto",n.disabled=!1;let x=S.querySelector("button.lk-disconnect-button")||S.querySelector('[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]');if(x&&x.parentNode){if(!x.__ebLeaveBound){const d=t=>{l.current=!0};x.addEventListener("click",d,!0),x.__ebLeaveBound=d}x.parentNode.insertBefore(n,x)}else S.appendChild(n)}if(n){const x=`
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
              ${x}
            </span>`;n.innerHTML=M?d:x,n.style.height="44px",n.style.minHeight="44px",n.style.padding="0 12px",n.style.display="flex",n.style.alignItems="center",n.style.justifyContent="flex-start",n.style.fontFamily="inherit",n.style.fontSize="14px",n.style.fontWeight="500",n.style.lineHeight="20px",n.style.pointerEvents="auto",n.disabled=!1,n.style.marginLeft="auto",n.parentElement===S&&S.lastElementChild!==n&&S.appendChild(n)}}};let c=!1;const v=()=>{c||(c=!0,requestAnimationFrame(()=>{c=!1,u()}))},i=new MutationObserver(()=>v());return i.observe(r,{childList:!0,subtree:!0,attributes:!0}),u(),()=>{i.disconnect();const o=r.querySelector(".call-container .lk-control-bar button.lk-disconnect-button")||r.querySelector('.call-container .lk-control-bar [aria-label*="Выйти" i], .call-container .lk-control-bar [title*="Выйти" i], .call-container .lk-control-bar [aria-label*="leave" i], .call-container .lk-control-bar [title*="leave" i]');o&&o.__ebLeaveBound&&(o.removeEventListener("click",o.__ebLeaveBound,!0),delete o.__ebLeaveBound)}},[k,O,R,M]),y.useEffect(()=>{if(!k)return;const r=document.body;if(!r)return;const u=A||null,c=()=>{r.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(o=>{const S=o.getAttribute("data-lk-local-participant")==="true"||o.dataset?.lkLocalParticipant==="true";let n=o.getAttribute("data-lk-participant-identity")||"";if(!n){const w=o.querySelector("[data-lk-participant-identity]");w&&(n=w.getAttribute("data-lk-participant-identity")||"")}if(!(S||!!(n&&u&&n===u)))return;const t=o.querySelector(".lk-participant-name, [data-lk-participant-name]");if(!t)return;const p=t.textContent||"",$=p.replace(/\s*\(мы\)\s*$/,"").trim();if(!$)return;const a=`${$} (мы)`;p!==a&&(t.textContent=a,t.hasAttribute("data-lk-participant-name")&&t.setAttribute("data-lk-participant-name",a))})};c();const v=new MutationObserver(()=>{setTimeout(c,50)});return v.observe(r,{childList:!0,subtree:!0,characterData:!0}),()=>v.disconnect()},[k,A]),y.useEffect(()=>{if(!k)return;const r=document.body;if(!r)return;const u=X||{},c=I||{},v=A||null,i=h||null,o=dt("lk-debug-avatars","lkDebugAvatars"),S=t=>{let p=0;for(let a=0;a<t.length;a++)p=t.charCodeAt(a)+((p<<5)-p);return`hsl(${Math.abs(p)%360} 70% 45%)`},n=(t,p)=>{const $=S(p),a=t.trim().charAt(0).toUpperCase(),w=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs/><rect width="256" height="256" rx="128" fill="${$}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="140" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" fill="#ffffff">${a}</text></svg>`;return`data:image/svg+xml;utf8,${encodeURIComponent(w)}`},x=()=>{r.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(p=>{const $=p.querySelector(".lk-participant-name, [data-lk-participant-name]"),a=p.querySelector(".lk-participant-placeholder");if(!$||!a)return;const w=p.querySelector("video.lk-participant-media-video")||p.querySelector("video"),Y=!!(!(p.getAttribute("data-video-muted")==="true"||p.getAttribute("data-lk-video-muted")==="true"||p.dataset?.videoMuted==="true"||p.dataset?.lkVideoMuted==="true")&&w&&w.offsetWidth>0&&w.offsetHeight>0);if(p.setAttribute("data-eb-has-video",Y?"true":"false"),Y){a.style.position="",a.style.inset="",a.style.left="",a.style.top="",a.style.right="",a.style.bottom="",a.style.transform="",a.style.width="",a.style.height="",a.style.maxWidth="",a.style.maxHeight="",a.style.minWidth="",a.style.minHeight="",a.style.margin="";return}let D="";const z={};for(let F=0;F<p.attributes.length;F++){const ot=p.attributes[F];ot.name.startsWith("data-")&&(z[ot.name]=ot.value)}const Z=p.getAttribute("data-lk-participant-identity");if(Z&&(D=Z.trim()),!D){const F=p.querySelector("[data-lk-participant-identity]");F&&(D=(F.getAttribute("data-lk-participant-identity")||"").trim())}if(!D){const F=p.dataset?.lkParticipantIdentity||p.dataset?.lkParticipantIdentity;F&&(D=String(F).trim())}if(!D){const F=["data-participant-identity","data-identity","data-participant-id","data-user-id"];for(const ot of F){const bt=p.getAttribute(ot);if(bt){D=bt.trim();break}}}const C=p.getAttribute("data-lk-participant-metadata")||(p.dataset?p.dataset.lkParticipantMetadata:"")||"";let N=null;if(C)try{N=JSON.parse(C)}catch{N=null}N?.userId&&(D=String(N.userId).trim());let j=($.textContent||$.getAttribute("data-lk-participant-name")||"").trim();const rt=j.replace(/\s*\(мы\)\s*$/,"").trim();if(!j&&N?.displayName&&(j=String(N.displayName).trim()),!j){const F=p.querySelector(".lk-participant-metadata");F?.textContent?.trim()&&(j=F.textContent.trim())}j||(j=D||"");const lt=!!(D&&v&&D===v),vt=D?c[D]??null:null,pt=rt||j.replace(/\s*\(мы\)\s*$/,"").trim(),mt=Object.keys(u).find(F=>F.toLowerCase()===pt.toLowerCase()),At=mt?u[mt]:null;let ft=vt??At??(lt?i||(v?c[v]??null:null):null);const ct=n(pt||D||"U",D||pt||"U");if(o&&!ft&&(D||j)){const F=Object.keys(u),ot=j?F.find(bt=>bt.toLowerCase()===j.toLowerCase()):null;console.log("[Avatars] Avatar not found:",{identity:D||"(empty)",name:j||"(empty)",isLocal:lt,localIdRef:v||"(empty)",byIdHasIdentity:D?D in c:!1,byNameHasName:!!ot,nameMatch:ot||"(no match)",participantMeta:N?{userId:N.userId,displayName:N.displayName}:null})}a.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(F=>F.remove()),a.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(F=>F.style.display="none");let W=a.querySelector("img.eb-ph");W||(W=document.createElement("img"),W.className="eb-ph",a.appendChild(W),W.onerror=()=>{W&&W.src!==ct&&(o&&console.log("[Avatars] Avatar image failed to load, using fallback:",W.src),W.src=ct)}),W.src!==(ft||ct)&&(W.src=ft||ct);const gt=p.getBoundingClientRect(),kt=Math.min(gt.width,gt.height),nt=Math.floor(kt*.95);a.style.position="absolute",a.style.inset="auto",a.style.left="50%",a.style.top="50%",a.style.right="auto",a.style.bottom="auto",a.style.transform="translate(-50%, -50%)",a.style.width=`${nt}px`,a.style.height=`${nt}px`,a.style.maxWidth=`${nt}px`,a.style.maxHeight=`${nt}px`,a.style.minWidth=`${nt}px`,a.style.minHeight=`${nt}px`,a.style.flexShrink="0",a.style.display="flex",a.style.alignItems="center",a.style.justifyContent="center",a.style.background="transparent",a.style.backgroundImage="none",a.style.color="transparent",a.style.fontSize="0",a.style.overflow="hidden",a.style.margin="0",a.style.borderRadius="50%",a.style.aspectRatio="1",W.alt=j,W.style.aspectRatio="1",W.style.width="80%",W.style.height="80%",W.style.maxWidth="80%",W.style.maxHeight="80%",W.style.objectFit="cover",W.style.borderRadius="50%",W.style.display="block",W.style.margin="auto",Array.from(a.childNodes).forEach(F=>{F.nodeType===Node.TEXT_NODE&&(F.textContent="")})})},d=new MutationObserver(x);return d.observe(r,{childList:!0,subtree:!0}),x(),()=>d.disconnect()},[k,X,I,A,h]),!k||!f||!H||!tt)return null;const e=T.jsx("div",{className:"call-overlay",onClick:r=>{r.stopPropagation()},onTouchStart:r=>{r.stopPropagation()},style:{position:"fixed",inset:0,background:_?"transparent":"rgba(10,12,16,0.55)",backdropFilter:_?"none":"blur(4px) saturate(110%)",display:_?"none":M?"flex":"block",alignItems:M?"center":void 0,justifyContent:M?"center":void 0,zIndex:1e3,pointerEvents:_?"none":"auto"},children:T.jsxs("div",{"data-lk-theme":"default",style:{width:_?0:M?"90vw":"100vw",height:_?0:M?"80vh":"100vh",minHeight:_?0:M?void 0:"100dvh",maxWidth:_?0:M?1200:"100vw",background:"var(--surface-200)",borderRadius:M?16:0,overflow:"hidden",position:"relative",border:M?"1px solid var(--surface-border)":"none",boxShadow:_?"none":M?"var(--shadow-sharp)":"none",opacity:_?0:1,visibility:_?"hidden":"visible"},className:"call-container",children:[T.jsx("style",{children:b}),T.jsx(It,{serverUrl:tt,token:H,connect:!0,video:G,audio:!it,onConnected:()=>{at(!0);try{f&&q&&(dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] joinCallRoom emit",{conversationId:f,video:B}),jt(f,B),Nt([f]))}catch(r){console.error("Error joining call room:",r)}},onDisconnected:r=>{dt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] onDisconnected:",r,"wasConnected:",E,"isGroup:",q,"minimized:",_);const u=E;at(!1);const c=r===1||l.current;_||(q?u&&c&&R({manual:!0}):c&&R({manual:!0}))},children:T.jsxs("div",{style:{width:"100%",height:"100%"},children:[T.jsx(zt,{}),T.jsx(Ht,{}),T.jsx(Ut,{localUserId:A}),T.jsx(Kt,{}),T.jsx(qt,{SettingsComponent:Vt})]})})]})});return Lt.createPortal(e,document.body)}export{ee as CallOverlay};
