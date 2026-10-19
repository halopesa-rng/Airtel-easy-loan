(function(){
  'use strict';
  const BRAND='School Management System';
  const DEVELOPER="O'LIVE TECH";
  function addLogo(){
    const brands=document.querySelectorAll('.brand');
    brands.forEach(b=>{
      if(b.querySelector('.gs-brand-logo')) return;
      const img=document.createElement('img');
      img.className='gs-brand-logo'; img.src='/olive-tech-logo.svg'; img.alt="O'LIVE TECH logo";
      img.onerror=()=>img.remove();
      b.insertBefore(img,b.firstChild);
    });
  }
  function addFooter(){
    if(document.querySelector('.gs-system-footer')) return;
    const f=document.createElement('footer');
    f.className='gs-system-footer';
    f.innerHTML='<span>© '+new Date().getFullYear()+' '+BRAND+'</span><span class="gs-footer-dot">•</span><span>Platform provider: <strong>'+DEVELOPER+'</strong></span>';
    document.body.appendChild(f);
  }
  function addPageTop(){
    document.querySelectorAll('main').forEach(main=>main.classList.add('gs-page-main'));
  }
  function run(){addLogo();addFooter();addPageTop();}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run); else run();
})();
