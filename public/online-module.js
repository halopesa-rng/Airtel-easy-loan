(function(){
'use strict';
if(window.__GS_ONLINE_MODULE__)return;window.__GS_ONLINE_MODULE__=true;
const token=()=>localStorage.getItem('gs_token')||'';
const role=()=>{try{return JSON.parse(localStorage.getItem('gs_user')||'{}').role||''}catch{return ''}};
const api=async(url,opt={})=>{const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{}),Authorization:'Bearer '+token()}});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d};
function target(){return document.getElementById('tiles')||document.getElementById('stats')||document.getElementById('studentCards')||document.getElementById('parentRecordCards')||document.querySelector('.cards')||document.querySelector('.tiles')||document.querySelector('.grid');}
function inject(){if(document.getElementById('gs-online-dashboard-card'))return;const t=target();if(!t)return;const a=document.createElement('a');a.id='gs-online-dashboard-card';a.href='/online';a.className='gs-dashboard-card gs-online-dashboard-card';a.innerHTML='<span class="gs-icon">🎥</span><span class="gs-title">Online Classes & Meetings</span><span class="gs-desc">Live classes, scheduled meetings and attendance</span><span class="gs-open">Open online centre →</span>';t.prepend(a)}
function boot(){inject();[250,800,1600].forEach(ms=>setTimeout(inject,ms))}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
