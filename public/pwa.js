(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

  let deferredPrompt = null;
  const addButton = () => {
    if (document.getElementById('installAppBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'installAppBtn';
    btn.type = 'button';
    btn.textContent = '📱 Install School App';
    btn.style.cssText = 'display:none;margin:14px auto 0;padding:12px 18px;border:0;border-radius:12px;background:#087f4b;color:#fff;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 5px 14px rgba(0,0,0,.12)';
    const target = document.querySelector('.login-card') || document.body;
    target.appendChild(btn);
    btn.addEventListener('click', async () => {
      if (!deferredPrompt) {
        alert('Use your browser menu and choose “Add to Home screen” or “Install app”.');
        return;
      }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.style.display = 'none';
    });
  };
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredPrompt = e; addButton();
    const b = document.getElementById('installAppBtn'); if (b) b.style.display = 'block';
  });
  window.addEventListener('appinstalled', () => { const b=document.getElementById('installAppBtn'); if(b)b.style.display='none'; });
  addButton();
})();
