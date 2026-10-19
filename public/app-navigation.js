/* school management system — Universal App Navigation v1.7.3
   Universal auto-open navigation for cards, table actions, generated records,
   buttons and internal module links. Destination content is presented at the
   top as the active view; scroll-to-section is never the primary behavior.
*/
(function(){
  'use strict';
  if(window.__GS_APP_NAV_173__) return;
  window.__GS_APP_NAV_173__=true;

  const titles={
    '/admin.html':'Admin Management','/director.html':'Director Dashboard','/principal.html':'Principal Dashboard',
    '/secretary.html':'Secretary Dashboard','/teacher.html':'Teacher Dashboard','/ustadh.html':'Ustadh Dashboard',
    '/worker.html':'Worker Dashboard','/parent.html':'Parent Portal','/student.html':'Student Portal',
    '/management.html':'Management Dashboard'
  };
  const dashboardTitle=titles[location.pathname]||document.title||'school management system';
  let root=null, activeView=null, placeholder=null, hiddenNodes=[], inDetail=false;

  const DETAIL_SELECTORS=[
    '#detail','#studentDetail','#childDetail','#parentRecordDetail','#panel',
    '.gs-detail-panel:not(.gs-collapsed)', '.management-detail:not(.gs-collapsed)',
    '.gs-detail:not(.gs-collapsed)','[data-gs-detail].gs-active',
    '.module-detail:not([hidden])','.record-detail:not([hidden])'
  ];

  function top(){
    try{window.scrollTo(0,0)}catch(e){}
    document.documentElement.scrollTop=0;
    document.body.scrollTop=0;
  }

  function ensureRoot(){
    if(root && root.isConnected) return root;
    root=document.createElement('main');
    root.id='gs-app-view-root';
    root.className='gs-app-view-root';
    root.setAttribute('aria-live','polite');
    const bar=document.querySelector('.gs-appbar');
    if(bar && bar.nextSibling) bar.parentNode.insertBefore(root,bar.nextSibling);
    else document.body.insertBefore(root,document.body.firstChild);
    return root;
  }

  function isChrome(el){return el===root || el?.classList?.contains('gs-appbar') || el?.id==='gs-app-view-root'}

  function hideDashboard(){
    hiddenNodes=[];
    [...document.body.children].forEach(el=>{
      if(isChrome(el) || el.hasAttribute('data-gs-nav-permanent')) return;
      if(el.hidden) return;
      hiddenNodes.push(el);
      el.hidden=true;
      el.setAttribute('data-gs-nav-hidden','1');
    });
    document.body.classList.add('gs-in-detail');
    document.documentElement.classList.add('gs-in-detail');
    inDetail=true;
  }

  function restoreDashboard(){
    hiddenNodes.forEach(el=>{
      if(el && el.isConnected && el.getAttribute('data-gs-nav-hidden')==='1'){
        el.hidden=false;
        el.removeAttribute('data-gs-nav-hidden');
      }
    });
    hiddenNodes=[];
    document.body.classList.remove('gs-in-detail');
    document.documentElement.classList.remove('gs-in-detail');
    inDetail=false;
  }

  function visible(el){
    if(!el || !el.isConnected) return false;
    const cs=getComputedStyle(el);
    return !el.hidden && cs.display!=='none' && cs.visibility!=='hidden' && !el.classList.contains('gs-collapsed');
  }

  function candidates(){
    const out=[];
    DETAIL_SELECTORS.forEach(sel=>document.querySelectorAll(sel).forEach(el=>{
      if(!out.includes(el) && visible(el)) out.push(el);
    }));
    return out;
  }

  function titleFor(el,fallback){
    return fallback || el?.querySelector('h1,h2,h3')?.textContent?.trim() || 'Details';
  }

  function setTitle(text){
    const el=document.querySelector('.gs-app-title');
    if(el) el.textContent=text||dashboardTitle;
  }

  function promote(el,title){
    if(!el || !el.isConnected) return false;
    const r=ensureRoot();
    if(activeView!==el){
      if(activeView && placeholder && placeholder.isConnected){
        placeholder.parentNode.insertBefore(activeView,placeholder);
        placeholder.remove();
      }
      placeholder=document.createComment('gs-app-view-placeholder');
      el.parentNode?.insertBefore(placeholder,el);
      r.replaceChildren();
      r.appendChild(el);
      activeView=el;
    }else if(el.parentNode!==r){
      r.replaceChildren();
      r.appendChild(el);
    }
    el.classList.add('gs-app-view');
    el.hidden=false;
    el.removeAttribute('aria-hidden');
    hideDashboard();
    r.hidden=false;
    r.classList.add('open');
    setTitle(titleFor(el,title));
    top();
    requestAnimationFrame(top);
    return true;
  }

  function promoteLatest(label){
    const list=candidates();
    if(!list.length) return false;
    return promote(list[list.length-1],label);
  }

  function leave(){
    if(activeView && placeholder && placeholder.isConnected){
      placeholder.parentNode.insertBefore(activeView,placeholder);
      placeholder.remove();
    }
    activeView=null; placeholder=null;
    if(root){root.replaceChildren();root.hidden=true;root.classList.remove('open');}
    restoreDashboard();
    setTitle(dashboardTitle);
    top();
  }

  function goBack(){
    // The dashboard is the canonical home state. Restore the original DOM and
    // remove any template/hash state before returning control to page scripts.
    // Do not call a module's back handler first: some older pages hide/show
    // their own containers and can leave the template root in an inconsistent
    // state, producing a blank/black dashboard.
    try{
      const u=new URL(location.href);
      u.searchParams.delete('gsview');
      u.hash='';
      history.replaceState(null,'',u.pathname+(u.search?u.search:''));
    }catch(e){}
    leave();
    // Reset any page-specific hidden state left by older dashboard handlers.
    document.querySelectorAll('[data-gs-nav-hidden="1"]').forEach(el=>{
      el.hidden=false; el.removeAttribute('data-gs-nav-hidden');
    });
    document.querySelectorAll('.gs-collapsed').forEach(el=>{
      if(el.classList.contains('gs-detail-panel')) el.classList.remove('gs-collapsed');
    });
    top();
    requestAnimationFrame(top);
  }

  function installBar(){
    if(document.querySelector('.gs-appbar')) return;
    const bar=document.createElement('nav');
    bar.className='gs-appbar';
    bar.setAttribute('aria-label','Application navigation');
    bar.innerHTML='<button type="button" class="gs-home">← Dashboard</button><div class="gs-app-title"></div><span class="gs-app-status" aria-live="polite"></span>';
    document.body.insertBefore(bar,document.body.firstChild);
    document.body.classList.add('gs-app');
    bar.querySelector('.gs-home').addEventListener('click',goBack);
    setTitle(dashboardTitle);
    ensureRoot().hidden=true;
  }

  function afterAction(label){
    // Existing functions can render immediately or after an API response.
    // A finite retry window catches both cases without observers/polling loops.
    [0,25,75,150,300,600].forEach(ms=>setTimeout(()=>promoteLatest(label),ms));
  }

  function isExternalOrSpecial(a){
    const href=a.getAttribute('href');
    if(!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return true;
    try{
      const u=new URL(href,location.href);
      return u.origin!==location.origin || u.target==='_blank';
    }catch(e){return true}
  }

  function internalLink(a){
    const href=a.getAttribute('href');
    if(!href || isExternalOrSpecial(a)) return false;
    try{
      const u=new URL(href,location.href);
      return u.origin===location.origin;
    }catch(e){return false}
  }

  // Every button/action in a generated table is handled, not only dashboard cards.
  document.addEventListener('click',function(e){
    const clickable=e.target.closest('button,a,[role="button"]');
    if(!clickable || clickable.closest('.gs-appbar')) return;

    const label=(clickable.getAttribute('aria-label')||clickable.textContent||'').trim().replace(/\s+/g,' ').slice(0,100);
    const card=clickable.closest('.tile,.teacher-tile,.gs-dashboard-card,.gs-dashboard-nav,[data-module],#studentCards > *,#parentRecordCards > *,#stats > *,#tiles > *');
    const row=clickable.closest('tr');

    // Same-page buttons: let the existing application action run, then promote
    // whichever detail/record it opened into the dedicated top-level view.
    if(clickable.tagName==='BUTTON' || clickable.getAttribute('role')==='button' || clickable.hasAttribute('onclick')){
      if(card) card.classList.add('gs-card-opening');
      afterAction(label);
      if(row) row.classList.add('gs-row-opening');
      if(card) setTimeout(()=>card.classList.remove('gs-card-opening'),220);
      if(row) setTimeout(()=>row.classList.remove('gs-row-opening'),220);
    }

    // Internal links navigate to another module/page. Mark the destination as
    // an app entry and force the destination page to start at its top.
    if(clickable.tagName==='A' && internalLink(clickable)){
      try{sessionStorage.setItem('gs-nav-entry',JSON.stringify({from:location.pathname,at:Date.now()}))}catch(err){}
      top();
    }

    // Hash links should never leave the user deep below the dashboard. If the
    // target is a real detail container, promote it instead of scrolling to it.
    if(clickable.tagName==='A' && clickable.getAttribute('href')?.startsWith('#')){
      const id=clickable.getAttribute('href').slice(1);
      const target=id?document.getElementById(id):null;
      if(target && (target.matches(DETAIL_SELECTORS.join(',')) || target.classList.contains('detail'))){
        e.preventDefault();
        promote(target,label);
        history.pushState({gsView:true},'',location.pathname+'#'+id);
      }
    }
  },true);

  // Patch common existing module entry functions after inline scripts load.
  function wrap(name){
    const original=window[name];
    if(typeof original!=='function' || original.__gs173) return;
    function wrapped(){
      const result=original.apply(this,arguments);
      const label=String(arguments[0]||name).replace(/[-_]/g,' ');
      Promise.resolve(result).then(()=>afterAction(label),()=>afterAction(label));
      return result;
    }
    wrapped.__gs173=true;
    wrapped.__gsOriginal=original;
    window[name]=wrapped;
  }

  function install(){
    installBar();
    ['openModule','showStudentDetail','openChild','openParentRecord','show','openPanel','attendance','leave',
     'communication','payroll','staffAttendance','leaveRequest','myPayroll','payrollOffice','openPayrollOffice',
     'staffCheckIn','staffCheckOut','openSheet','openMerit','viewGroup','manageGroup','results','students',
     'examBank','calendar','fees','marks','tahfidh','reports','documents'].forEach(wrap);
    top();
    try{sessionStorage.removeItem('gs-nav-entry')}catch(e){}
  }

  window.addEventListener('pageshow',top);
  window.addEventListener('popstate',()=>{top();if(location.hash){const id=location.hash.slice(1),target=document.getElementById(id);if(target && visible(target)) promote(target)}});

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install,{once:true});
  else install();
})();
