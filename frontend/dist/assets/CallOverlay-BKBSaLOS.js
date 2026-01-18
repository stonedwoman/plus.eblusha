import{r as b,j as A}from"./vendor-query-CNP5Hy5J.js";import{u as jt,P as It,m as Pt,f as qt,d as Ft,M as Bt}from"./index-PdH-PUwq.js";import{W as Wt,a as Ot,t as $t,C as wt,u as yt,O as Tt,R as ht,f as St,T as Lt,b as Ut,s as zt,L as Ht}from"./index-BRAGuiMP.js";import{c as Kt,X as Vt}from"./ChatsPage-OfwAxn_L.js";import"./vendor-react-BcTlWpV0.js";import"./vendor-socket-CA1CrNgP.js";import"./vendor-crypto-GGjuBpPe.js";if(typeof window<"u"&&typeof navigator<"u"&&navigator.mediaDevices&&!window.__eblushaEnumeratePatched){const x=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);navigator.mediaDevices.enumerateDevices=async()=>{const d=await x(),j=navigator.userAgent||"";if(!/iP(ad|hone|od)/i.test(j))return d;const L=[],$=[],V=[],J=(B,N)=>{const W=B.toLowerCase();return/(front|перед|selfie|true depth|ultra wide front)/.test(W)?"front":/(back|rear|зад|tele|wide|камера на задней панели|камера на задней|задняя)/.test(W)||/(back|rear)/.test(N.toLowerCase())?"back":"other"};d.forEach(B=>{if(B.kind!=="videoinput"){V.push(B);return}const N=J(B.label||"",B.deviceId||"");N==="front"?L.push(B):$.push(B)});const Z=[];if(L.length>0&&Z.push(L[0]),$.length>0&&Z.push($[0]),Z.length===0&&d.some(B=>B.kind==="videoinput")){const B=d.find(N=>N.kind==="videoinput");B&&Z.push(B)}return V.forEach(B=>{B.kind!=="videoinput"&&Z.push(B)}),Z},window.__eblushaEnumeratePatched=!0}try{zt(Ht.warn)}catch{}const dt={aec:"eb.lk.webrtc.aec",ns:"eb.lk.webrtc.ns",agc:"eb.lk.webrtc.agc"};function Rt(x,d){if(typeof window>"u")return d;try{const j=window.localStorage.getItem(x);return j===null?d:j==="1"||j==="true"}catch{return d}}function Ct(x,d){if(!(typeof window>"u"))try{window.localStorage.setItem(x,d?"1":"0")}catch{}}function pt(x,d){if(typeof window>"u")return!1;try{const U=new URLSearchParams(window.location.search).get(d);if(U==="1"||U==="true")return!0;const L=window.localStorage.getItem(x);return L==="1"||L==="true"}catch{return!1}}function At({label:x,description:d,checked:j,onChange:U,disabled:L=!1,rightHint:$}){return A.jsxs("div",{className:"eb-toggle-row",children:[A.jsxs("div",{className:"eb-toggle-text",children:[A.jsx("div",{className:"eb-toggle-label",children:x}),d?A.jsx("div",{className:"eb-toggle-desc",children:d}):null]}),A.jsxs("div",{className:"eb-toggle-right",children:[$?A.jsx("div",{className:"eb-toggle-hint",children:$}):null,A.jsxs("label",{className:`eb-switch ${L?"is-disabled":""}`,children:[A.jsx("input",{type:"checkbox",checked:j,disabled:L,onChange:V=>U(V.target.checked)}),A.jsx("span",{className:"eb-switch-track","aria-hidden":"true"})]})]})]})}function Xt(){const x=$t();let d="Подключено";return x===wt.Connecting?d="Подключение…":x===wt.Reconnecting?d="Переподключение…":x===wt.Disconnected&&(d="Отключено"),A.jsx("div",{className:"eb-conn-badge",style:{position:"absolute",top:10,left:10,zIndex:20,padding:"6px 10px",borderRadius:999,background:"rgba(0,0,0,0.45)",border:"1px solid rgba(255,255,255,0.12)",fontSize:12,color:"#fff",backdropFilter:"blur(6px)"},children:d})}function Zt(){const x=yt(),{isMicrophoneEnabled:d}=Tt(),j=b.useRef(!1);return b.useEffect(()=>{x&&(j.current||d&&(j.current=!0,x.localParticipant.setMicrophoneEnabled(!0,{deviceId:"default"}).catch(U=>console.warn("[DefaultMicrophoneSetter] Failed to set default microphone",U))))},[x,d]),null}function Jt({localUserId:x}){const d=yt(),{localParticipant:j,microphoneTrack:U,cameraTrack:L}=Tt(),[$,V]=b.useState(null),J=b.useRef(null),[Z,B]=b.useState(null),N=b.useRef(null),W=b.useRef(null),H=b.useRef(new Map),nt=b.useRef(new Map),tt=b.useRef(0),X=b.useRef(!1),at=b.useRef(!1),K=b.useRef(0),G=b.useRef({at:0,rtt:null}),[m,_]=b.useState(()=>pt("lk-debug-ping","lkDebugPing")),Q=b.useRef({at:0,lastLocalRtt:null,lastSignalRtt:null}),P=(...p)=>{m&&console.log("[Ping]",...p)};b.useEffect(()=>{const p=window.setInterval(()=>{const l=pt("lk-debug-ping","lkDebugPing");_(g=>g===l?g:l)},1e3);return()=>window.clearInterval(p)},[]),b.useEffect(()=>{if(m){P("debug enabled",{localStorage:(()=>{try{return window.localStorage.getItem("lk-debug-ping")}catch{return"(unavailable)"}})(),query:(()=>{try{return new URLSearchParams(window.location.search).get("lkDebugPing")}catch{return"(unavailable)"}})(),localIdentity:j?.identity??null});try{const l=performance?.getEntriesByType?.("resource")?.map(g=>g.name).find(g=>g.includes("/assets/CallOverlay-"))??null;l&&P("asset",l)}catch{}}},[m,j?.identity]),b.useEffect(()=>{N.current=Z,W.current?.(),m&&P("localPlayoutMs state",Z)},[Z]),b.useEffect(()=>{if(!d)return;const p=f=>{let n=null;try{f.forEach(y=>{if(y?.type!=="inbound-rtp")return;const a=(y?.kind||y?.mediaType||"").toString().toLowerCase();if(a&&a!=="audio")return;const c=typeof y?.jitterBufferTargetDelay=="number"?y.jitterBufferTargetDelay:null;if(typeof c=="number"&&Number.isFinite(c)&&c>0){const s=c*1e3;Number.isFinite(s)&&s>0&&s<5e3&&(n=n===null?s:Math.max(n,s))}const u=typeof y?.jitterBufferDelay=="number"?y.jitterBufferDelay:null,e=typeof y?.jitterBufferEmittedCount=="number"?y.jitterBufferEmittedCount:null;if(typeof u=="number"&&typeof e=="number"&&Number.isFinite(u)&&Number.isFinite(e)&&u>0&&e>=50){const s=u/e*1e3;Number.isFinite(s)&&s>0&&s<5e3&&(n=n===null?s:Math.max(n,s))}})}catch{}return n};let l=!1;const g=async()=>{try{const n=d.engine?.pcManager?.subscriber;if(n?.getStats){const y=await n.getStats(),a=p(y);l||B(a),m&&P("playout sample",{ms:a});return}}catch(f){m&&P("playout sample failed",f)}l||B(null)},T=window.setInterval(g,2e3);return g(),()=>{l=!0,window.clearInterval(T)}},[d,m]);const it=p=>p.getAttribute("data-lk-local-participant")==="true"?!0:p.dataset?.lkLocalParticipant==="true",o=p=>{const l=p.querySelector("[data-lk-participant-name]")||p.querySelector(".lk-participant-name"),g=l?.getAttribute("data-lk-participant-name"),T=g&&g.trim()||(l?.textContent?.trim()??"");return T?T.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null};return b.useEffect(()=>{if(!d||!j)return;const p=f=>{try{let n=null;const y=e=>{const s=(typeof e?.currentRoundTripTime=="number"?e.currentRoundTripTime:null)??(typeof e?.roundTripTime=="number"?e.roundTripTime:null)??(typeof e?.totalRoundTripTime=="number"&&Number.isFinite(e.totalRoundTripTime)&&e.totalRoundTripTime>0&&typeof e?.responsesReceived=="number"&&Number.isFinite(e.responsesReceived)&&e.responsesReceived>0?e.totalRoundTripTime/e.responsesReceived:null);return typeof s!="number"||!Number.isFinite(s)||s<=0?null:s};let a=null,c=null;f.forEach(e=>{e?.type==="transport"&&e.selectedCandidatePairId&&(a=String(e.selectedCandidatePairId))}),a&&(c=f.get?.(a)??(()=>{let e=null;return f.forEach(s=>{e||s?.id===a&&(e=s)}),e})()??null),c||f.forEach(e=>{c||e?.type==="candidate-pair"&&(e.selected||e.nominated||e.state==="succeeded")&&(c=e)});const u=c?y(c):null;if(typeof u=="number"&&Number.isFinite(u)&&u>0&&(n=u),f.forEach(e=>{if(e?.type!=="candidate-pair"||!(e.selected||e.nominated||e.state==="succeeded"))return;const s=y(e);typeof s=="number"&&(n===null||s<n)&&(n=s)}),f.forEach(e=>{if(e?.type!=="remote-inbound-rtp")return;const s=(typeof e?.roundTripTime=="number"?e.roundTripTime:null)??(typeof e?.totalRoundTripTime=="number"&&Number.isFinite(e.totalRoundTripTime)&&e.totalRoundTripTime>0&&typeof e?.roundTripTimeMeasurements=="number"&&Number.isFinite(e.roundTripTimeMeasurements)&&e.roundTripTimeMeasurements>0?e.totalRoundTripTime/e.roundTripTimeMeasurements:null);typeof s!="number"||!Number.isFinite(s)||s<=0||(n===null||s<n)&&(n=s)}),f.forEach(e=>{const s=typeof e?.roundTripTime=="number"?e.roundTripTime:null;typeof s!="number"||!Number.isFinite(s)||s<=0||(n===null||s<n)&&(n=s)}),typeof n=="number"&&Number.isFinite(n)&&n>0)return n*1e3}catch{}return null},l=async()=>{try{const f=d.engine,n=f?.client?.rtt;if((!n||n<=0)&&typeof f?.client?.sendPing=="function"){const h=Date.now();if(h-K.current>5e3){K.current=h;try{await f.client.sendPing(),m&&P("signal sendPing() called")}catch(i){m&&P("signal sendPing() failed",i)}}}if(m){const h=Date.now(),i=Q.current;(typeof n=="number"?n:null)!==i.lastSignalRtt&&h-i.at>750&&(Q.current={...i,at:h,lastSignalRtt:typeof n=="number"?n:null},P("signal rtt",{rtt:n,hasEngine:!!f,localIdentity:j.identity}))}if(typeof n=="number"&&Number.isFinite(n)&&n>0){V(n),m&&P("local rtt set",{ms:Math.round(n),source:"engine.client.rtt"});return}const y=U?.track;if(y&&typeof y.getSenderStats=="function")try{const h=await y.getSenderStats(),i=typeof h?.roundTripTime=="number"?h.roundTripTime:null;if(typeof i=="number"&&Number.isFinite(i)&&i>0){const k=i*1e3;V(k),m&&P("local rtt set",{ms:Math.round(k),source:"LocalAudioTrack.getSenderStats().roundTripTime"});return}}catch(h){m&&P("mic getSenderStats failed",h)}const a=L?.track;if(a&&typeof a.getSenderStats=="function")try{const h=await a.getSenderStats(),k=(Array.isArray(h)?h:[]).map(t=>typeof t?.roundTripTime=="number"?t.roundTripTime:null).filter(t=>typeof t=="number"&&Number.isFinite(t)&&t>0);if(k.length>0){const v=Math.min(...k)*1e3;V(v),m&&P("local rtt set",{ms:Math.round(v),source:"LocalVideoTrack.getSenderStats()[].roundTripTime"});return}}catch(h){m&&P("camera getSenderStats failed",h)}const c=Date.now();if(c-tt.current<3e3)return;const u=f?.pcManager?.publisher,e=f?.pcManager?.subscriber,s=[u,e].filter(Boolean),w=[U?.track,L?.track].filter(Boolean);if(s.length>0||w.length>0)tt.current=c;else{m&&!at.current&&(at.current=!0,P("waiting for transports/tracks",{publisher:!!u,subscriber:!!e,trackCandidates:w.length}));return}for(const h of s){if(!h?.getStats)continue;const i=await h.getStats(),k=p(i);if(typeof k=="number"&&Number.isFinite(k)&&k>0){V(k),m&&P("local rtt set",{ms:Math.round(k),source:"pcTransport.getStats()"});return}}for(const h of w){if(!h?.getRTCStatsReport)continue;const i=await h.getRTCStatsReport();if(!i)continue;const k=p(i);if(typeof k=="number"&&Number.isFinite(k)&&k>0){V(k),m&&P("local rtt set",{ms:Math.round(k),source:"MediaStreamTrack.getRTCStatsReport()"});return}}X.current||(X.current=!0,m&&P("could not compute local rtt",{signalRtt:n,transports:s.length,trackCandidates:w.length,localIdentity:j.identity}))}catch(f){m&&P("updateRtt error",f)}},g=setInterval(()=>void l(),1500);l();const T=setTimeout(()=>void l(),2500);return()=>{clearInterval(g),clearTimeout(T)}},[d,j,U?.trackSid,L?.trackSid]),b.useEffect(()=>{if(!d||!j)return;const p=new TextEncoder,l=async()=>{try{const n=J.current;if(typeof n!="number"||!Number.isFinite(n)||n<=0){m&&P("skip publish eb.ping (no local rtt yet)",{localRtt:n});return}const y=Date.now(),a=G.current,c=a.rtt===null||Math.abs(a.rtt-n)>=2;if(!(y-a.at>=2e3)&&!c)return;G.current={at:y,rtt:n};const e=N.current,s={t:"eb.ping",v:2,rtt:Math.round(n),playoutMs:typeof e=="number"&&Number.isFinite(e)&&e>=0?Math.round(e):0,ts:y};await j.publishData(p.encode(JSON.stringify(s)),{reliable:!1,topic:"eb.ping"}),m&&P("publish eb.ping ok",s)}catch(n){m&&P("publish eb.ping failed",n),m&&!window.__ebPingPublishWarned&&(window.__ebPingPublishWarned=!0,console.warn("[Ping] Failed to publish eb.ping (data channel). Check LiveKit token grant canPublishData=true."))}},g=new TextDecoder,T=(n,y,a,c)=>{if(c&&c!=="eb.ping")return;const u=y?.identity;if(u&&!(j&&u===j.identity))try{const e=JSON.parse(g.decode(n));if(!e||e.t!=="eb.ping")return;const s=Number(e.rtt);if(!Number.isFinite(s)||s<=0)return;const w=Number(e.playoutMs),h=Number.isFinite(w)&&w>=0?w:0,i=typeof y?.name=="string"&&y.name?y.name:null,k=H.current.get(u);H.current.set(u,s),i&&H.current.set(i,s),nt.current.set(u,h),i&&nt.current.set(i,h);const t=typeof y?.metadata=="string"?y.metadata:null;if(t)try{const v=JSON.parse(t);v?.displayName&&H.current.set(String(v.displayName),s),v?.userId&&H.current.set(String(v.userId),s),v?.displayName&&nt.current.set(String(v.displayName),h),v?.userId&&nt.current.set(String(v.userId),h)}catch{}m&&(k===void 0||Math.abs(k-s)>=2)&&P("recv eb.ping",{from:u,name:i,rtt:s,playoutMs:h,ts:e.ts,topic:c??null}),W.current?.()}catch{}};d.on(ht.DataReceived,T);const f=setInterval(()=>void l(),2e3);return l(),()=>{clearInterval(f),d.off(ht.DataReceived,T)}},[d,j,m]),b.useEffect(()=>{J.current=$,W.current?.(),m&&P("localRtt state",$)},[$]),b.useEffect(()=>{if(!d)return;const p=document.querySelector(".call-container");if(!p)return;const l=y=>{const a=J.current;return typeof a!="number"||!Number.isFinite(a)||a<=0?"—":y?`${Math.round(a)} мс`:"—"},g=()=>{const y=p.querySelectorAll(".lk-participant-metadata-item[data-lk-quality]");m&&P("dom scan",{indicators:y.length}),y.forEach(a=>{const c=a.closest(".lk-participant-tile, [data-participant]");if(!c)return;const u=it(c),e=o(c);a.classList.contains("eb-ping-display")||a.classList.add("eb-ping-display");let s=a.querySelector(".eb-ping-text");s||(s=document.createElement("span"),s.className="eb-ping-text",a.appendChild(s));let w=null,h=l(u);if(u){const t=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&(w=Math.round(t),h=`${w} мс`)}else{const t=(e?H.current.get(e):void 0)??void 0,v=(e?nt.current.get(e):void 0)??0,S=J.current;typeof t=="number"&&Number.isFinite(t)&&t>0&&typeof S=="number"&&S>0&&(w=Math.round((t+S)/2+(typeof v=="number"&&Number.isFinite(v)&&v>=0?v:0)),h=`${w} мс`)}const i=typeof w=="number"&&Number.isFinite(w)&&w>0;if(a.classList.toggle("eb-ping-has-value",i),typeof w=="number"&&Number.isFinite(w)&&w>0){const t=w<=200?"good":w<=500?"warn":"bad";a.setAttribute("data-eb-ping-level",t)}else a.removeAttribute("data-eb-ping-level");const k=i?h:"";if(s.textContent!==k&&(s.textContent=k,m)){const t=J.current,v=e?H.current.get(e):void 0;P("dom set",{name:e,isLocal:u,text:k,mine:t,remote:v})}})};let T=!1;const f=()=>{T||(T=!0,requestAnimationFrame(()=>{T=!1,g()}))};W.current=f;const n=new MutationObserver(()=>f());return n.observe(p,{childList:!0,subtree:!0}),f(),()=>{W.current===f&&(W.current=null),n.disconnect()}},[d,j,x,m]),null}function Yt(){const x=yt(),d=b.useRef(null),j=b.useRef(new Map),U=b.useRef(0),L=b.useRef(new WeakMap),$=b.useRef(new Map),V=o=>o.getAttribute("data-lk-local-participant")==="true"?!0:o.dataset?.lkLocalParticipant==="true",J=o=>{const p=o.querySelector("[data-lk-participant-name]")||o.querySelector(".lk-participant-name"),l=p?.getAttribute("data-lk-participant-name"),g=l&&l.trim()||(p?.textContent?.trim()??"");return g?g.replace(/[\u2019']/g,"'").replace(/'s\s+screen$/i,"").trim():null},Z=o=>{const p=o.getAttribute("data-lk-participant-identity")||o.getAttribute("data-participant-identity")||o.getAttribute("data-user-id")||o.dataset?.lkParticipantIdentity||"",l=String(p||"").trim();if(l)return l;const g=o.getAttribute("data-lk-participant-metadata")||(o.dataset?o.dataset.lkParticipantMetadata:"")||"";if(g)try{const T=JSON.parse(g);if(T?.userId)return String(T.userId).trim()}catch{}return null},B=o=>{const p=Z(o),l=J(o),g=p||l;return g?{key:g,userId:p,name:l}:null},N=o=>{const p=j.current,l=p.get(o);if(l)return l;const g={volume:1,muted:!1,lastNonZeroPct:100};return p.set(o,g),g},W=async()=>{if(U.current=Date.now(),d.current){try{d.current.state!=="running"&&await d.current.resume()}catch{}return d.current}try{const o=new(window.AudioContext||window.webkitAudioContext);d.current=o;try{o.state!=="running"&&await o.resume()}catch{}return o}catch{return null}},H=o=>{const p=o?.metadata;if(!p||typeof p!="string")return null;try{const l=JSON.parse(p);if(!l||typeof l!="object")return null;const g=l.userId?String(l.userId):void 0,T=l.displayName?String(l.displayName):void 0;return{userId:g,displayName:T}}catch{return null}},nt=o=>{if(!x)return null;const p=(o.userId?x.remoteParticipants.get(o.userId):null)||x.remoteParticipants.get(o.key)||null;if(p)return p;const l=(o.name||"").trim(),g=(o.key||"").trim(),T=(o.userId||"").trim();for(const f of x.remoteParticipants.values())try{if(T&&String(f.identity)===T||g&&String(f.identity)===g||l&&String(f.name||"").trim()===l)return f;const n=H(f);if(T&&n?.userId&&n.userId===T||l&&n?.displayName&&n.displayName.trim()===l)return f}catch{}return null},tt=async(o,p)=>{if(!x)return;const{key:l}=o,g=nt(o);if(!g)return;const T=N(l),f=T.muted?0:T.volume,n=f>1,y=d.current||(n&&p?await W():null),a=[];try{const c=g.trackPublications;if(c?.values)for(const u of c.values())a.push(u)}catch{}for(const c of a){if(c?.kind!==Lt.Kind.Audio)continue;if(typeof c?.setEnabled=="function")try{c.setEnabled(!T.muted&&f>0)}catch{}const u=c?.track;if(!(u instanceof Ut))continue;const e=L.current.get(u);if(n&&y){(!e||e.ctx!==y||!e.enabled)&&(u.setAudioContext(y),L.current.set(u,{ctx:y,enabled:!0}));try{u.attachedElements.forEach(w=>{try{w.volume=0,w.muted=!0}catch{}})}catch{}}else{if(e?.enabled){try{u.setAudioContext(void 0)}catch{}L.current.set(u,{ctx:e.ctx,enabled:!1})}try{const w=T.muted||f<=0;u.attachedElements.forEach(h=>{try{h.muted=w}catch{}})}catch{}}const s=T.muted?0:Math.max(0,Math.min(n?1.5:1,f));u.setVolume(s)}};b.useEffect(()=>{if(!x)return;const o=(p,l,g)=>{try{const T=String(g?.identity||""),f=String(g?.name||""),n=T||f;if(!n||g?.isLocal)return;j.current.has(n)&&p?.kind===Lt.Kind.Audio&&tt({key:n,userId:T||null,name:f||null},!1)}catch{}};return x.on(ht.TrackSubscribed,o),()=>{x.off(ht.TrackSubscribed,o)}},[x]);const X=150,at=100,K=105,G=2*Math.PI*K,m=o=>Math.max(0,Math.min(X,Math.round(o))),_=o=>m(o.muted?0:o.volume*100),Q=(o,p,l)=>{const g=Math.max(0,G-l);o.style.strokeDasharray=`${l} ${g}`,o.style.strokeDashoffset=`-${p}`,o.style.opacity=l>0?"1":"0"},P=(o,p,l)=>{const g=o.__ebRingSafe,T=o.__ebRingOver,f=o.__ebRingThumb,n=o.__ebRingLabel,y=o.__ebRingVal,a=o.__ebRingMuteBtn;if(!g||!T)return;const c=m(p),u=Math.min(c,at)/X,e=Math.max(c-at,0)/X,s=G*u,w=G*e;if(Q(g,0,s),Q(T,s,w),f){const i=c/X*(Math.PI*2),k=110+K*Math.cos(i),t=110+K*Math.sin(i);f.setAttribute("cx",`${k}`),f.setAttribute("cy",`${t}`),f.style.opacity="1"}y?y.textContent=`${c}%`:n&&(n.textContent=`${c}%`),a&&(a.textContent=l||c===0?"Вернуть":"Заглушить"),o.setAttribute("data-eb-over",c>at?"true":"false"),o.setAttribute("data-eb-muted",l||c===0?"true":"false")},it=(o,p)=>{const l=p.getBoundingClientRect(),g=l.left+l.width/2,T=l.top+l.height/2,f=o.clientX-g,n=o.clientY-T;let y=Math.atan2(n,f)*180/Math.PI;y=(y+90+360)%360;const a=y/360;return m(a*X)};return b.useEffect(()=>{if(!x)return;const o=document.body;if(!o)return;const p=()=>{try{o.querySelectorAll(".call-container .lk-participant-tile").forEach(n=>{if(V(n))return;const y=B(n);if(!y)return;n.setAttribute("data-eb-remote","true");const a=nt(y),c=a?String(a.identity):y.key,e=(a?H(a):null)?.displayName||y.name||null,s={key:c,userId:c,name:e};n.setAttribute("data-eb-vol-key",c);const w=n.getAttribute("data-video-muted")==="true"||n.getAttribute("data-lk-video-muted")==="true"||n.dataset?.videoMuted==="true"||n.dataset?.lkVideoMuted==="true",h=n.querySelector("video.lk-participant-media-video")||n.querySelector("video");if(!!(!w&&h&&h.offsetWidth>0&&h.offsetHeight>0)){n.querySelectorAll(".eb-vol-ring").forEach(R=>R.remove());return}const k=n.querySelector(".lk-participant-placeholder");if(!k)return;n.style.position||(n.style.position="relative");let t=n.querySelector(".eb-vol-ring");if(t?t.setAttribute("data-eb-vol-key",c):(t=document.createElement("div"),t.className="eb-vol-ring",t.setAttribute("data-eb-vol-key",c),t.innerHTML=`
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
            `,n.appendChild(t)),!t.__ebRingInit){t.__ebRingInit=!0;const R=t.querySelector("svg.eb-vol-ring-svg"),r=t.querySelector("circle.safe"),M=t.querySelector("circle.over"),F=t.querySelector("circle.thumb"),et=t.querySelector("circle.hit"),E=t.querySelector(".label"),Y=t.querySelector(".label .val"),C=t.querySelector("button.btn.mute"),q=t.querySelector("button.btn.reset");t.__ebRingSvg=R,t.__ebRingSafe=r,t.__ebRingOver=M,t.__ebRingThumb=F,t.__ebRingHit=et,t.__ebRingLabel=E,t.__ebRingVal=Y,t.__ebRingMuteBtn=C,t.__ebRingResetBtn=q}const v=()=>{const R=N(c),r=_(R);r>0&&(R.lastNonZeroPct=r),P(t,r,!!R.muted)};try{const R=n.getBoundingClientRect(),r=n.offsetWidth||R.width||1,M=n.offsetHeight||R.height||1,F=R.width?R.width/r:1,et=R.height?R.height/M:1,E=k.getBoundingClientRect(),C=k.querySelector("img.eb-ph")?.getBoundingClientRect(),q=C&&C.width>10?C.width:E.width*.8,O=(F+et)/2||1,z=q/O,lt=C&&C.width>10?C.left-R.left+C.width/2:E.left-R.left+E.width/2,mt=C&&C.height>10?C.top-R.top+C.height/2:E.top-R.top+E.height/2,bt=lt/F-n.clientLeft,vt=mt/et-n.clientTop,ft=220,Mt=105-10/2,rt=0,ot=z/2,D=ft*(ot+rt)/Mt,xt=Math.min(Math.min(n.clientWidth||r,n.clientHeight||M)-6,D),ct=Math.max(56,xt);ct<150?t.setAttribute("data-eb-compact","true"):t.removeAttribute("data-eb-compact"),t.style.width=`${ct}px`,t.style.height=`${ct}px`,t.style.left=`${bt}px`,t.style.top=`${vt}px`,t.style.transform="translate(-50%, -50%)"}catch{}const S=(R,r)=>{let M=m(R);const F=String(t?.getAttribute("data-eb-vol-key")||c).trim();if(!F)return;const et=typeof t.__ebLastPct=="number"?t.__ebLastPct:M;if(t.__ebDragging){const Y=M-et;Math.abs(Y)>X/2&&(M=et>X/2?X:0)}t.__ebLastPct=M;const E=N(F);M===0?(E.muted=!0,E.volume=0):(E.muted=!1,E.lastNonZeroPct=M,E.volume=M/100),P(t,M,!!E.muted),tt({key:F,userId:F,name:null},r)};if(!t.__ebRingBound){t.__ebRingBound=!0;const R=t.__ebRingSvg,r=t.__ebRingHit,M=t.__ebRingMuteBtn,F=t.__ebRingResetBtn;if(R&&r){r.addEventListener("pointerdown",C=>{C.preventDefault(),C.stopPropagation(),U.current=Date.now(),t.__ebDragging=!0;try{const O=String(t?.getAttribute("data-eb-vol-key")||"").trim();O&&(t.__ebLastPct=_(N(O)))}catch{}try{r.setPointerCapture?.(C.pointerId)}catch{}const q=it(C,R);S(q,!0)}),r.addEventListener("pointermove",C=>{if(!t.__ebDragging)return;C.preventDefault(),C.stopPropagation();const q=it(C,R);S(q,!0)});const Y=C=>{t.__ebDragging&&(t.__ebDragging=!1);try{r.releasePointerCapture?.(C.pointerId)}catch{}};r.addEventListener("pointerup",Y),r.addEventListener("pointercancel",Y)}const et=Y=>{Y.preventDefault(),Y.stopPropagation();const C=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!C)return;const q=N(C),O=_(q);if(q.muted||O===0){const lt=m(q.lastNonZeroPct||100);q.muted=!1,q.lastNonZeroPct=Math.max(1,lt),q.volume=q.lastNonZeroPct/100}else O>0&&(q.lastNonZeroPct=O),q.muted=!0,q.volume=0;const z=_(q);t.__ebLastPct=z,P(t,z,!!q.muted),tt({key:C,userId:C,name:null},!0)},E=Y=>{Y.preventDefault(),Y.stopPropagation();const C=String(t?.getAttribute("data-eb-vol-key")||"").trim();if(!C)return;const q=N(C);q.muted=!1,q.lastNonZeroPct=100,q.volume=1;const O=_(q);t.__ebLastPct=O,P(t,O,!!q.muted),tt({key:C,userId:C,name:null},!0)};M?.addEventListener("click",et),F?.addEventListener("click",E)}n.__ebVolWheelBound||(n.__ebVolWheelBound=!0,n.addEventListener("wheel",R=>{R.preventDefault(),R.stopPropagation();const r=String(n.getAttribute("data-eb-vol-key")||"").trim();if(!r)return;const M=N(r),F=_(M),et=(R.deltaMode===1?R.deltaY*40:R.deltaMode===2?R.deltaY*(window.innerHeight||800):R.deltaY)||0,E=$.current,C=(E.get(r)||0)+et;E.set(r,C);const q=100,O=Math.trunc(Math.abs(C)/q);if(O<=0)return;const z=O*q*Math.sign(C);E.set(r,C-z);const lt=R.shiftKey?2:1,mt=C<0?1:-1;S(F+mt*O*lt,!0)},{passive:!1})),v(),tt(s,!1)})}catch{}};let l=!1;const g=()=>{l||(l=!0,requestAnimationFrame(()=>{l=!1,p()}))},T=new MutationObserver(()=>g());return T.observe(o,{childList:!0,subtree:!0}),p(),()=>{T.disconnect()}},[x]),null}function Gt(){const x=yt(),{isMicrophoneEnabled:d,microphoneTrack:j}=Tt(),[U,L]=b.useState(()=>Rt(dt.aec,!0)),[$,V]=b.useState(()=>Rt(dt.ns,!0)),[J,Z]=b.useState(()=>Rt(dt.agc,!0)),B=b.useRef("");return b.useEffect(()=>{if(!x||!d)return;const N=`${U}|${$}|${J}|${j?.trackSid??""}`;B.current!==N&&(B.current=N,x.localParticipant.setMicrophoneEnabled(!0,{echoCancellation:U,noiseSuppression:$,autoGainControl:J}).catch(W=>console.warn("[CallSettings] Failed to apply mic capture options",W)))},[x,d,U,$,J,j?.trackSid]),b.useEffect(()=>{const N=()=>{const nt=document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li"),tt=[],X=new Map;nt.forEach(K=>{const G=K.querySelector(".lk-button");if(!G)return;const m=G.textContent||"",_=/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i.test(m);let Q=m.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim();Q=Q.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),X.has(Q)||X.set(Q,[]),X.get(Q).push(K),_&&tt.push(K)}),tt.forEach(K=>{K.remove()}),document.querySelectorAll(".call-container .lk-settings-menu-modal .lk-media-device-select li > .lk-button").forEach(K=>{const G=Array.from(K.childNodes).find(_=>_.nodeType===Node.TEXT_NODE);let m=K.querySelector("span.eb-device-label");if(G&&!m){const _=G.textContent||"";m=document.createElement("span"),m.className="eb-device-label",m.textContent=_,K.replaceChild(m,G)}if(m){let _=m.textContent||"";_=_.replace(/^(Оборудование\s*-\s*|По\s+умолчанию\s*-\s*)/i,"").trim(),_=_.replace(/\s*\([0-9a-fA-F]{4}:[0-9a-fA-F]{0,4}\)?\s*/g,"").trim(),_=_.replace(/\s*\([0-9a-fA-F]{4}:\s*$/,"").trim(),_!==m.textContent&&(m.textContent=_),setTimeout(()=>{const Q=K.getBoundingClientRect(),P=m.getBoundingClientRect(),o=Q.width-24;if(P.width>o){const p=P.width-o;m.setAttribute("data-overflows","true"),m.style.setProperty("--eb-device-scroll-distance",`${-p}px`)}else m.removeAttribute("data-overflows"),m.style.removeProperty("--eb-device-scroll-distance")},10)}})};N();const W=new MutationObserver(()=>{setTimeout(N,50)}),H=document.querySelector(".call-container .lk-settings-menu-modal");if(H)return W.observe(H,{childList:!0,subtree:!0,characterData:!0}),()=>W.disconnect()},[]),A.jsxs("div",{className:"eb-call-settings",style:{width:"100%"},children:[A.jsxs("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,marginBottom:12},children:[A.jsx("div",{style:{fontSize:18,fontWeight:600},children:"Настройки"}),A.jsx("button",{type:"button",className:"btn btn-icon btn-ghost","aria-label":"Закрыть настройки",title:"Закрыть настройки",onClick:N=>{N.preventDefault(),N.stopPropagation();const W=document.querySelector(".call-container .lk-settings-toggle");if(W){W.click();return}const H=document.querySelector(".call-container .lk-settings-menu-modal");H&&(H.style.display="none")},style:{padding:8},children:A.jsx(Vt,{size:18})})]}),A.jsxs("div",{className:"eb-settings-section",children:[A.jsx("div",{className:"eb-section-title",children:"Обработка микрофона"}),A.jsx(At,{label:"WebRTC: AEC (анти-эхо)",description:"Эхо‑подавление на уровне браузера (лучше включать почти всегда).",checked:U,onChange:N=>{L(N),Ct(dt.aec,N)}}),A.jsx(At,{label:"WebRTC: NS (шумоподавление)",description:"Шумоподавление на уровне браузера.",checked:$,onChange:N=>{V(N),Ct(dt.ns,N)}}),A.jsx(At,{label:"WebRTC: AGC (автогейн)",description:"Автоматическая регулировка усиления микрофона.",checked:J,onChange:N=>{Z(N),Ct(dt.agc,N)}}),A.jsx("div",{className:"eb-settings-note",children:"Изменения AEC/NS/AGC применяются перезапуском микрофона и могут дать короткий “пик” при переключении."})]}),A.jsxs("div",{className:"eb-settings-grid",style:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))",gap:16,alignItems:"start",marginBottom:12},children:[A.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[A.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Микрофон"}),A.jsx(St,{kind:"audioinput",requestPermissions:!0})]}),A.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[A.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Камера"}),A.jsx(St,{kind:"videoinput",requestPermissions:!0})]}),A.jsxs("div",{className:"eb-device-col",style:{minWidth:0},children:[A.jsx("div",{style:{fontSize:12,opacity:.8,marginBottom:8},children:"Вывод звука"}),A.jsx(St,{kind:"audiooutput",requestPermissions:!0}),A.jsx("div",{style:{fontSize:11,opacity:.65,marginTop:6},children:"На Safari/iOS переключение устройства вывода может быть недоступно."})]})]}),A.jsx("div",{style:{fontSize:12,opacity:.8},children:"Выберите устройства ввода. Закрыть это окно можно кнопкой «Настройки» внизу."})]})}function oe({open:x,conversationId:d,onClose:j,onMinimize:U,minimized:L=!1,initialVideo:$=!1,initialAudio:V=!0,peerAvatarUrl:J=null,avatarsByName:Z={},avatarsById:B={},localUserId:N=null,isGroup:W=!1}){const[H,nt]=b.useState(null),[tt,X]=b.useState(null),[at,K]=b.useState(!V),[G,m]=b.useState(!!$),[_,Q]=b.useState(()=>typeof window<"u"?window.innerWidth>768:!0),[P,it]=b.useState(!1),o=jt(a=>a.session?.user),p=b.useRef(!1),l=b.useRef(!1),g=b.useMemo(()=>o?.avatarUrl??null,[o?.avatarUrl]),T=b.useCallback(a=>{if(!a)return null;if(a.startsWith("data:")||a.startsWith("blob:")||typeof window>"u")return a;const c=Kt(a);if(c&&c!==a)return c;if(a.startsWith("/")||a.startsWith("http://")||a.startsWith("https://"))return a;try{const u=window.location,e=new URL(a,u.origin);return e.host===u.host&&e.protocol!==u.protocol&&(e.protocol=u.protocol),e.toString()}catch{return a}},[]),f=b.useCallback(a=>{if(p.current||(p.current=!0),a?.manual&&(l.current=!0),d&&W){try{It(d)}catch(u){console.error("Error leaving call room:",u)}try{Pt([d])}catch(u){console.error("Error requesting call status update:",u)}}const c=l.current?{...a??{},manual:!0}:a;j(c)},[d,W,j]),n=`
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
  `;if(b.useEffect(()=>{let a=!0;async function c(){if(!x||!d)return;const u=`conv-${d}`,e=await Ft.post("/livekit/token",{room:u,participantMetadata:{app:"eblusha",userId:o?.id,displayName:o?.displayName??o?.username,avatarUrl:g}});if(a){nt(e.data.token),X(e.data.url);try{const s=String(e.data.token||"").split(".");if(s.length>=2){const w=s[1].replace(/-/g,"+").replace(/_/g,"/"),h=JSON.parse(atob(w)),i=!!h?.video?.canPublishData||!!h?.video?.can_publish_data;pt("lk-debug-ping","lkDebugPing")&&console.log("[Ping] LiveKit grant canPublishData:",i)}}catch{}}}return c(),()=>{a=!1,nt(null),X(null)}},[x,d]),b.useEffect(()=>{x&&(m(!!$),K(!V),it(!1))},[x,$,V]),b.useEffect(()=>{if(!x)return;if(typeof window<"u"&&window.innerWidth<=768){const c=document.body.style.overflow;return document.body.style.overflow="hidden",()=>{document.body.style.overflow=c}}},[x]),b.useEffect(()=>{x||(p.current=!1,l.current=!1)},[x]),b.useEffect(()=>{const a=()=>Q(typeof window<"u"?window.innerWidth>768:!0);return window.addEventListener("resize",a),()=>window.removeEventListener("resize",a)},[]),b.useEffect(()=>{if(!x)return;const a=document.body;if(!a)return;const c=()=>{const w=new Set;document.querySelectorAll(".call-container [aria-label], .call-container [title]").forEach(i=>w.add(i)),document.querySelectorAll(".call-container .lk-control-bar button, .call-container button.lk-button").forEach(i=>w.add(i)),w.forEach(i=>{const k=i.getAttribute("aria-label")||i.getAttribute("title")||"";let t="";const v=k.toLowerCase();if(v.includes("microphone")?t=k.includes("mute")?"Выключить микрофон":"Включить микрофон":v.includes("camera")?t=k.includes("disable")||v.includes("off")?"Выключить камеру":"Включить камеру":v.includes("screen")?t=v.includes("stop")?"Остановить показ экрана":"Поделиться экраном":v.includes("flip")?t="Сменить камеру":v.includes("participants")?t="Участники":v.includes("settings")?t="Настройки":v.includes("leave")||v.includes("hang")?t="Выйти":v.includes("chat")&&(t="Чат"),t&&(i.setAttribute("aria-label",t),i.setAttribute("title",t)),i.tagName==="BUTTON"){const S=document.createTreeWalker(i,NodeFilter.SHOW_TEXT);let R=S.nextNode();for(;R;){const M=(R.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();let F=null;M==="leave"?F="Выйти":M==="participants"?F="Участники":M==="settings"?F="Настройки":M==="microphone"?F="Микрофон":M==="camera"?F="Камера":M==="connecting"?F="Подключение":M==="reconnecting"?F="Переподключение":M==="disconnected"?F="Отключено":(M==="screen share"||M==="share screen"||M==="share-screen"||M==="share-screen "||M.includes("share")&&M.includes("screen"))&&(F="Показ экрана"),F&&(R.nodeValue=F,i.setAttribute("aria-label",F),i.setAttribute("title",F)),R=S.nextNode()}}}),document.querySelectorAll(".call-container .lk-toast-connection-state").forEach(i=>{const k=document.createTreeWalker(i,NodeFilter.SHOW_TEXT);let t=k.nextNode();for(;t;){const S=(t.nodeValue||"").replace(/\s+/g," ").trim().toLowerCase();S==="connecting"?t.nodeValue="Подключение":S==="reconnecting"?t.nodeValue="Переподключение":S==="disconnected"&&(t.nodeValue="Отключено"),t=k.nextNode()}});const h=a.querySelector(".call-container .lk-control-bar")||a.querySelector(".call-container [data-lk-control-bar]")||a.querySelector('.call-container [role="toolbar"]');if(h&&U){let i=h.querySelector(".eb-minimize-btn");if(!i){if(i=document.createElement("button"),i.className="eb-minimize-btn lk-button",i.setAttribute("aria-label","Свернуть"),i.setAttribute("title","Свернуть"),i.setAttribute("type","button"),i.innerHTML=`
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
          `,!i.__ebMinBound){i.__ebMinBound=!0;const t=v=>{v.preventDefault(),v.stopPropagation();try{U?.()}catch(S){console.error("Minimize click error",S)}};i.__ebMinHandler=t,i.addEventListener("click",t,!0),i.addEventListener("pointerup",t,!0),i.addEventListener("touchend",t,!0),i.addEventListener("keydown",v=>{v?.key!=="Enter"&&v?.key!==" "||t(v)})}i.style.pointerEvents="auto",i.disabled=!1;let k=h.querySelector("button.lk-disconnect-button")||h.querySelector('[aria-label*="Выйти" i], [title*="Выйти" i], [aria-label*="leave" i], [title*="leave" i]');if(k&&k.parentNode){if(!k.__ebLeaveBound){const t=v=>{l.current=!0};k.addEventListener("click",t,!0),k.__ebLeaveBound=t}k.parentNode.insertBefore(i,k)}else h.appendChild(i)}if(i){const k=`
            <svg fill="currentColor" stroke="currentColor" width="30px" height="30px" version="1.1" viewBox="144 144 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" transform="matrix(6.123233995736766e-17,1,-1,6.123233995736766e-17,0,0)">
              <g id="IconSvg_bgCarrier" stroke-width="0"></g>
              <g id="IconSvg_tracerCarrier" stroke-linecap="round" stroke-linejoin="round" stroke="#CCCCCC"></g>
              <g id="IconSvg_iconCarrier">
                <path d="m546.94 400v125.95-0.003906c0 5.5703-2.2109 10.91-6.1484 14.844-3.9336 3.9375-9.2734 6.1484-14.844 6.1484h-251.9c-5.5664 0-10.906-2.2109-14.844-6.1484-3.9375-3.9336-6.1484-9.2734-6.1484-14.844v-251.9c0-5.5664 2.2109-10.906 6.1484-14.844s9.2773-6.1484 14.844-6.1484h125.95c7.5 0 14.43 4 18.18 10.496 3.75 6.4961 3.75 14.496 0 20.992-3.75 6.4961-10.68 10.496-18.18 10.496h-104.96v209.92h209.92v-104.96c0-7.5 4.0039-14.43 10.496-18.18 6.4961-3.75 14.5-3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
                <path fill="#d97706" stroke="#d97706" d="m567.93 253.05c0.019531-2.457-0.48047-4.8906-1.4688-7.1367-1.0117-2.043-2.2812-3.9492-3.7773-5.668l-1.6797-1.2578v-0.003907 c-1.2461-1.2812-2.7461-2.2812-4.4102-2.9375h-1.8906 0.003907c-2.2812-1.8594-4.9297-3.2188-7.7695-3.9883h-62.977 c-7.4961 0-14.43 4-18.18 10.496-3.7461 6.4961-3.7461 14.496 0 20.992 3.75 6.4961 10.684 10.496 18.18 10.496h12.387 l-111.26 111.05c-3.9727 3.9414-6.2109 9.3086-6.2109 14.906s2.2383 10.961 6.2109 14.902c3.9414 3.9727 9.3086 6.2109 14.906 6.2109s10.961-2.2383 14.902-6.2109l111.05-111.26v12.387c0 7.5 4.0039 14.43 10.496 18.18 6.4961 3.75 14.5 3.75 20.992 0 6.4961-3.75 10.496-10.68 10.496-18.18z"></path>
              </g>
            </svg>`,t=`
            <span style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 14px; font-family: inherit; font-weight: 500; line-height: 20px;">Свернуть</span>
              ${k}
            </span>`;i.innerHTML=_?t:k,i.style.height="44px",i.style.minHeight="44px",i.style.padding="0 12px",i.style.display="flex",i.style.alignItems="center",i.style.justifyContent="flex-start",i.style.fontFamily="inherit",i.style.fontSize="14px",i.style.fontWeight="500",i.style.lineHeight="20px",i.style.pointerEvents="auto",i.disabled=!1,i.style.marginLeft="auto",i.parentElement===h&&h.lastElementChild!==i&&h.appendChild(i)}}};let u=!1;const e=()=>{u||(u=!0,requestAnimationFrame(()=>{u=!1,c()}))},s=new MutationObserver(()=>e());return s.observe(a,{childList:!0,subtree:!0,attributes:!0}),c(),()=>{s.disconnect();const w=a.querySelector(".call-container .lk-control-bar button.lk-disconnect-button")||a.querySelector('.call-container .lk-control-bar [aria-label*="Выйти" i], .call-container .lk-control-bar [title*="Выйти" i], .call-container .lk-control-bar [aria-label*="leave" i], .call-container .lk-control-bar [title*="leave" i]');w&&w.__ebLeaveBound&&(w.removeEventListener("click",w.__ebLeaveBound,!0),delete w.__ebLeaveBound)}},[x,U,f,_]),b.useEffect(()=>{if(!x)return;const a=document.body;if(!a)return;const c=N||null,u=()=>{a.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(w=>{const h=w.getAttribute("data-lk-local-participant")==="true"||w.dataset?.lkLocalParticipant==="true";let i=w.getAttribute("data-lk-participant-identity")||"";if(!i){const M=w.querySelector("[data-lk-participant-identity]");M&&(i=M.getAttribute("data-lk-participant-identity")||"")}if(!(h||!!(i&&c&&i===c)))return;const v=w.querySelector(".lk-participant-name, [data-lk-participant-name]");if(!v)return;const S=v.textContent||"",R=S.replace(/\s*\(мы\)\s*$/,"").trim();if(!R)return;const r=`${R} (мы)`;S!==r&&(v.textContent=r,v.hasAttribute("data-lk-participant-name")&&v.setAttribute("data-lk-participant-name",r))})};u();const e=new MutationObserver(()=>{setTimeout(u,50)});return e.observe(a,{childList:!0,subtree:!0,characterData:!0}),()=>e.disconnect()},[x,N]),b.useEffect(()=>{if(!x)return;const a=document.body;if(!a)return;const c=Z||{},u=B||{},e=N||null,s=g||null,w=pt("lk-debug-avatars","lkDebugAvatars"),h=v=>{let S=0;for(let r=0;r<v.length;r++)S=v.charCodeAt(r)+((S<<5)-S);return`hsl(${Math.abs(S)%360} 70% 45%)`},i=(v,S)=>{const R=h(S),r=v.trim().charAt(0).toUpperCase(),M=`<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs/><rect width="256" height="256" rx="128" fill="${R}"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="140" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" fill="#ffffff">${r}</text></svg>`;return`data:image/svg+xml;utf8,${encodeURIComponent(M)}`},k=()=>{a.querySelectorAll(".call-container .lk-participant-tile, .call-container [data-participant]").forEach(S=>{const R=S.querySelector(".lk-participant-name, [data-lk-participant-name]"),r=S.querySelector(".lk-participant-placeholder");if(!r)return;const M=S.querySelector("video.lk-participant-media-video")||S.querySelector("video"),et=!!(!(S.getAttribute("data-video-muted")==="true"||S.getAttribute("data-lk-video-muted")==="true"||S.dataset?.videoMuted==="true"||S.dataset?.lkVideoMuted==="true")&&M&&M.offsetWidth>0&&M.offsetHeight>0);if(S.setAttribute("data-eb-has-video",et?"true":"false"),et){r.querySelectorAll("img.eb-ph").forEach(I=>I.remove()),r.style.position="",r.style.inset="",r.style.left="",r.style.top="",r.style.right="",r.style.bottom="",r.style.transform="",r.style.width="",r.style.height="",r.style.maxWidth="",r.style.maxHeight="",r.style.minWidth="",r.style.minHeight="",r.style.margin="";return}let E="";const Y={};for(let I=0;I<S.attributes.length;I++){const st=S.attributes[I];st.name.startsWith("data-")&&(Y[st.name]=st.value)}const C=S.getAttribute("data-lk-participant-identity");if(C&&(E=C.trim()),!E){const I=S.querySelector("[data-lk-participant-identity]");I&&(E=(I.getAttribute("data-lk-participant-identity")||"").trim())}if(!E){const I=S.dataset?.lkParticipantIdentity||S.dataset?.lkParticipantIdentity;I&&(E=String(I).trim())}if(!E){const I=["data-participant-identity","data-identity","data-participant-id","data-user-id"];for(const st of I){const gt=S.getAttribute(st);if(gt){E=gt.trim();break}}}const q=S.getAttribute("data-lk-participant-metadata")||(S.dataset?S.dataset.lkParticipantMetadata:"")||"";let O=null;if(q)try{O=JSON.parse(q)}catch{O=null}O?.userId&&(E=String(O.userId).trim());let z=(R?.textContent||R?.getAttribute("data-lk-participant-name")||"").trim();const lt=z.replace(/\s*\(мы\)\s*$/,"").trim();if(!z&&O?.displayName&&(z=String(O.displayName).trim()),!z){const I=S.querySelector(".lk-participant-metadata");I?.textContent?.trim()&&(z=I.textContent.trim())}z||(z=E||"");const bt=!!(E&&e&&E===e),vt=E?u[E]??null:null,ft=lt||z.replace(/\s*\(мы\)\s*$/,"").trim(),kt=Object.keys(c).find(I=>I.toLowerCase()===ft.toLowerCase()),Nt=kt?c[kt]:null;let rt=vt??Nt??(bt?s||(e?u[e]??null:null):null);rt=T(rt);const ot=i(ft||E||"U",E||ft||"U");if(w&&!rt&&(E||z)){const I=Object.keys(c),st=z?I.find(gt=>gt.toLowerCase()===z.toLowerCase()):null;console.log("[Avatars] Avatar not found:",{identity:E||"(empty)",name:z||"(empty)",isLocal:bt,localIdRef:e||"(empty)",byIdHasIdentity:E?E in u:!1,byNameHasName:!!st,nameMatch:st||"(no match)",participantMeta:O?{userId:O.userId,displayName:O.displayName}:null})}let D=r.querySelector("img.eb-ph");D||(D=document.createElement("img"),D.className="eb-ph",r.appendChild(D));const xt=D.dataset.ebFailedUrl||"",ct=rt&&rt!==xt?rt:ot,Et=()=>{r.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(I=>I.remove()),r.querySelectorAll("svg:not(.eb-vol-ring-svg)").forEach(I=>I.style.display="none")};D.dataset.ebAvatarUrl=ct,D.dataset.ebFallback=ot,D.onload=()=>{D.dataset.ebLoaded="1",Et()},D.onerror=()=>{const I=D?.dataset?.ebAvatarUrl||"";I&&I!==ot&&(D.dataset.ebFailedUrl=I),D.dataset.ebLoaded="",w&&console.log("[Avatars] Avatar image failed to load, using fallback:",D?.getAttribute("src")||""),I&&I!==ot&&D&&D.getAttribute("src")!==ot&&(D.src=ot)},D.getAttribute("src")!==ct&&(D.src=ct),D.complete&&D.naturalWidth>0&&(D.dataset.ebLoaded="1",Et());const _t=S.getBoundingClientRect(),Dt=Math.min(_t.width,_t.height),ut=Math.floor(Dt*.95);r.style.position="absolute",r.style.inset="auto",r.style.left="50%",r.style.top="50%",r.style.right="auto",r.style.bottom="auto",r.style.transform="translate(-50%, -50%)",r.style.width=`${ut}px`,r.style.height=`${ut}px`,r.style.maxWidth=`${ut}px`,r.style.maxHeight=`${ut}px`,r.style.minWidth=`${ut}px`,r.style.minHeight=`${ut}px`,r.style.flexShrink="0",r.style.display="flex",r.style.alignItems="center",r.style.justifyContent="center",r.style.background="transparent",r.style.backgroundImage="none",r.style.color="transparent",r.style.fontSize="0",r.style.overflow="hidden",r.style.margin="0",r.style.borderRadius="50%",r.style.aspectRatio="1",D.alt=z,D.style.aspectRatio="1",D.style.width="80%",D.style.height="80%",D.style.maxWidth="80%",D.style.maxHeight="80%",D.style.objectFit="cover",D.style.borderRadius="50%",D.style.display="block",D.style.margin="auto",Array.from(r.childNodes).forEach(I=>{I.nodeType===Node.TEXT_NODE&&(I.textContent="")})})},t=new MutationObserver(k);return t.observe(a,{childList:!0,subtree:!0}),k(),()=>t.disconnect()},[x,Z,B,N,g]),!x||!d||!H||!tt)return null;const y=A.jsx("div",{className:"call-overlay",onClick:a=>{a.stopPropagation()},onTouchStart:a=>{a.stopPropagation()},style:{position:"fixed",inset:0,background:L?"transparent":"rgba(10,12,16,0.55)",backdropFilter:L?"none":"blur(4px) saturate(110%)",display:L?"none":_?"flex":"block",alignItems:_?"center":void 0,justifyContent:_?"center":void 0,zIndex:1e3,pointerEvents:L?"none":"auto"},children:A.jsxs("div",{"data-lk-theme":"default",style:{width:L?0:_?"90vw":"100vw",height:L?0:_?"80vh":"100vh",minHeight:L?0:_?void 0:"100dvh",maxWidth:L?0:_?1200:"100vw",background:"var(--surface-200)",borderRadius:_?16:0,overflow:"hidden",position:"relative",border:_?"1px solid var(--surface-border)":"none",boxShadow:L?"none":_?"var(--shadow-sharp)":"none",opacity:L?0:1,visibility:L?"hidden":"visible"},className:"call-container",children:[A.jsx("style",{children:n}),A.jsx(Wt,{serverUrl:tt,token:H,connect:!0,video:G,audio:!at,onConnected:()=>{it(!0);try{d&&W&&(pt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] joinCallRoom emit",{conversationId:d,video:$}),Bt(d,$),Pt([d]))}catch(a){console.error("Error joining call room:",a)}},onDisconnected:a=>{pt("lk-debug-call","lkDebugCall")&&console.log("[CallOverlay] onDisconnected:",a,"wasConnected:",P,"isGroup:",W,"minimized:",L);const c=P;it(!1);const u=a===1||l.current;L||(W?c&&u&&f({manual:!0}):u&&f({manual:!0}))},children:A.jsxs("div",{style:{width:"100%",height:"100%"},children:[A.jsx(Xt,{}),A.jsx(Zt,{}),A.jsx(Jt,{localUserId:N}),A.jsx(Yt,{}),A.jsx(Ot,{SettingsComponent:Gt})]})})]})});return qt.createPortal(y,document.body)}export{oe as CallOverlay};
