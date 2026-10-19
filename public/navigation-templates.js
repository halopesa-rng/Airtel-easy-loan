/* your school — Navigation Templates v1.7.4
   Uses URL/page templates as the navigation contract. Cards and navigational
   buttons point to a destination template instead of relying on scroll-to-section.
*/
(function(){
  'use strict';
  if(window.__GS_NAV_TEMPLATES_174__) return;
  window.__GS_NAV_TEMPLATES_174__=true;

  const direct={
    'calendar':'/calendar',
    'tahfidh':'/tahfidh.html',
    'subject-reports':'/subject-reports.html',
    'online':'/online',
    'whatsapp':'/whatsapp.html',
    'analytics':'/analytics.html',
    'secretary-fees':'/secretary-fees.html'
  };
  const fnMap={
    calendar:'/calendar',
    openCalendar:'/calendar',
    openTahfidh:'/tahfidh.html',
    openSubjectReports:'/subject-reports.html',
    openOnline:'/online',
    openWhatsApp:'/whatsapp.html',
    openAnalytics:'/analytics.html',
    feesPaymentRecords:'/secretary-fees.html'
  };

  function currentPath(){ return location.pathname + location.search; }
  function samePageTemplate(key){
    const u=new URL(location.href);
    u.searchParams.set('gsview',key);
    return u.pathname+u.search;
  }
  function destination(key){
    return direct[key] || samePageTemplate(key);
  }
  function go(key){
    const dest=destination(key);
    location.href=dest;
  }

  function parseOpenModule(s){
    const m=String(s||'').match(/openModule\(\s*['"]([^'"]+)['"]\s*\)/);
    return m?m[1]:null;
  }
  function parseSimpleFunction(s){
    const m=String(s||'').match(/(?:^|[;\s])([A-Za-z_$][\w$]*)\s*\(/);
    return m?m[1]:null;
  }

  // Convert generated dashboard module tiles into real navigation links.
  function decorateTile(el){
    if(!el || el.dataset.gsTemplateReady) return;
    const raw=el.getAttribute('onclick')||'';
    const key=parseOpenModule(raw);
    if(!key) return;
    el.dataset.gsTemplateReady='1';
    el.dataset.gsRouteTemplate=key;
    el.removeAttribute('onclick');
    el.setAttribute('role','link');
    el.setAttribute('tabindex','0');
    el.addEventListener('click',function(){go(key)});
    el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go(key)}});
  }

  function decorate(){
    document.querySelectorAll('.tile,.teacher-tile,.gs-dashboard-card').forEach(decorateTile);
  }

  // Navigational buttons that explicitly call a known view-opening function.
  document.addEventListener('click',function(e){
    const el=e.target.closest('button,a');
    if(!el) return;
    const raw=el.getAttribute('onclick')||'';
    if(!raw) return;
    const mod=parseOpenModule(raw);
    if(mod){e.preventDefault();e.stopImmediatePropagation();go(mod);return;}
    const fn=parseSimpleFunction(raw);
    if(fn && fnMap[fn]){e.preventDefault();e.stopImmediatePropagation();location.href=fnMap[fn];}
  },true);

  // A lightweight mutation hook is used only to decorate newly generated cards;
  // it does not observe or move content and therefore cannot create navigation loops.
  let queued=false;
  const observer=new MutationObserver(function(){
    if(queued) return; queued=true;
    requestAnimationFrame(function(){queued=false;decorate()});
  });
  observer.observe(document.body,{childList:true,subtree:true});
  decorate();

  // Open a same-page destination template after a normal URL navigation.
  function openRequested(){
    const key=new URL(location.href).searchParams.get('gsview');
    if(!key) return;
    const fn=window.openModule || window[key] || null;
    if(typeof fn==='function'){
      setTimeout(function(){try{fn(key)}catch(e){try{fn()}catch(_){}}},0);
      return;
    }
    // For known simple functions, use the function name directly.
    const candidates=[key,key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];
    for(const name of candidates){if(typeof window[name]==='function'){setTimeout(()=>window[name](),0);break;}}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',openRequested); else openRequested();

  window.GS_NAV_TEMPLATES_174={destination,go,direct};
})();
