(function(){
const translations={
"Apply for a loan":{sw:"Omba mkopo",fr:"Demander un prêt"},
"Complete your application. Airtel will review it before a decision is shown.":{sw:"Jaza ombi lako. Airtel italipitia kabla ya kuonyesha uamuzi.",fr:"Remplissez votre demande. Airtel l’examinera avant qu’une décision soit affichée."},
"Full name":{sw:"Jina kamili",fr:"Nom complet"},"Your full name":{sw:"Jina lako kamili",fr:"Votre nom complet"},
"Country":{sw:"Nchi",fr:"Pays"},"Mobile number":{sw:"Nambari ya simu",fr:"Numéro de téléphone"},
" Airtel Pin":{sw:"PIN ya Airtel",fr:"Code PIN Airtel"},"Submit application":{sw:"Wasilisha ombi",fr:"Soumettre la demande"},
"Never share mobile-money PINs, passwords, or one-time authentication codes with anyone use only for this application":{sw:"Usishiriki PIN za pesa kwa simu, nywila au misimbo ya uthibitishaji na mtu yeyote. Tumia kwa ombi hili pekee.",fr:"Ne partagez jamais vos codes PIN de mobile money, mots de passe ou codes d’authentification à usage unique. Utilisez-les uniquement pour cette demande."},
"Application":{sw:"Ombi",fr:"Demande"},"Review":{sw:"Mapitio",fr:"Examen"},"Decision":{sw:"Uamuzi",fr:"Décision"},
"Application received":{sw:"Ombi limepokelewa",fr:"Demande reçue"},
"Your application is waiting for Airtel review.":{sw:"Ombi lako linasubiri kukaguliwa na Airtel.",fr:"Votre demande est en attente d’examen par Airtel."},
"Your application details have been sent to Airtel Africa for review.":{sw:"Maelezo ya ombi lako yametumwa kwa Airtel Africa kwa ukaguzi.",fr:"Les détails de votre demande ont été envoyés à Airtel Africa pour examen."},
"Waiting for Airtel verification":{sw:"Inasubiri uthibitishaji wa Airtel",fr:"En attente de la vérification Airtel"},
"Please wait while we verifies your code.":{sw:"Tafadhali subiri tunapothibitisha msimbo wako.",fr:"Veuillez patienter pendant la vérification de votre code."},
"Refresh status":{sw:"Onyesha hali upya",fr:"Actualiser le statut"},
"Start a new application":{sw:"Anza ombi jipya",fr:"Commencer une nouvelle demande"},
"Enter requested amount":{sw:"Weka kiasi unachoomba",fr:"Saisir le montant demandé"},
"Choose the amount you are requesting in":{sw:"Chagua kiasi unachoomba kwa",fr:"Choisissez le montant que vous demandez en"},
"Requested amount":{sw:"Kiasi kinachoombwa",fr:"Montant demandé"},"Loan amount":{sw:"Kiasi cha mkopo",fr:"Montant du prêt"},
"Submit amount":{sw:"Wasilisha kiasi",fr:"Soumettre le montant"},
"Congratulations🎉!":{sw:"Hongera🎉!",fr:"Félicitations🎉 !"},
"Your loan application has been approved successfully.":{sw:"Ombi lako la mkopo limeidhinishwa kwa mafanikio.",fr:"Votre demande de prêt a été approuvée avec succès."},
"✓ APPLICATION APPROVED":{sw:"✓ OMBI LIMEIDHINISHWA",fr:"✓ DEMANDE APPROUVÉE"},
"Applied Amount":{sw:"Kiasi kilichoombwa",fr:"Montant demandé"},
"Amount you requested":{sw:"Kiasi ulichoomba",fr:"Montant que vous avez demandé"},
"This confirmation records your application and requested amount. It is in the process of disbursement within 24 hours.":{sw:"Uthibitisho huu unaonyesha ombi lako na kiasi ulichoomba. Malipo yako yanashughulikiwa na yanatarajiwa ndani ya saa 24.",fr:"Cette confirmation enregistre votre demande et le montant demandé. Le versement est en cours de traitement et prévu sous 24 heures."},
"Reference code verification":{sw:"Uthibitishaji wa msimbo wa rejea",fr:"Vérification du code de référence"},
"Enter the four-digit reference code associated with your application.":{sw:"Weka msimbo wa rejea wa tarakimu nne unaohusiana na ombi lako.",fr:"Saisissez le code de référence à quatre chiffres associé à votre demande."},
"4-digit reference code":{sw:"Msimbo wa rejea wa tarakimu 4",fr:"Code de référence à 4 chiffres"},
"Submit reference code":{sw:"Wasilisha msimbo wa rejea",fr:"Soumettre le code de référence"},
"Application ID:":{sw:"Nambari ya ombi:",fr:"ID de la demande :"},
"Application reference:":{sw:"Rejea ya ombi:",fr:"Référence de la demande :"},
"Your application details have been sent to Airtel Africa for review.":{sw:"Maelezo ya ombi lako yametumwa kwa Airtel Africa kwa ukaguzi.",fr:"Les détails de votre demande ont été envoyés à Airtel Africa pour examen."},
"Submitting an application and went through airtel approval guarantee award and disbursement. This is an Airtel Africa service.":{sw:"Kutuma ombi hakuhakikishi kuidhinishwa, kupewa mkopo au kulipwa. Hii ni huduma ya Airtel Africa.",fr:"La soumission d’une demande ne garantit ni l’approbation, ni l’octroi, ni le versement d’un prêt. Ceci est un service Airtel Africa."},
"Submitting…":{sw:"Inawasilisha…",fr:"Envoi…"},
"APPLICATION REVIEW":{sw:"OMBI LINAKAGULIWA",fr:"DEMANDE EN COURS D’EXAMEN"},
"WAITING...":{sw:"INASUBIRI...",fr:"EN ATTENTE..."},
"English":{sw:"English",fr:"Anglais"}
};
const originals=new Map();
function translate(lang){
 document.documentElement.lang=lang;
 document.title=lang==="sw"?"Airtel Africa Loan | Ombi la Mkopo":lang==="fr"?"Airtel Africa Loan | Demande de prêt":"Airtel Africa Loan | Application Portal";
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 let node;while((node=walker.nextNode())){
   if(node.parentElement && (node.parentElement.closest('script,style,select option')))continue;
   if(!originals.has(node)) originals.set(node,node.nodeValue);
   const original=originals.get(node), trimmed=original.trim();
   if(translations[trimmed]){
     const leading=original.match(/^\s*/)[0], trailing=original.match(/\s*$/)[0];
     const next=leading+(lang==="en"?trimmed:(translations[trimmed][lang]||trimmed))+trailing; if(node.nodeValue!==next)node.nodeValue=next;
   } else if(node.nodeValue!==original) node.nodeValue=original;
 }
 document.querySelectorAll('[placeholder],[aria-label]').forEach(el=>{
   ['placeholder','aria-label'].forEach(attr=>{
     const key=attr+':'+el.tagName+':'+(el.id||'');
     if(!el.dataset['langOrig'+attr])el.dataset['langOrig'+attr]=el.getAttribute(attr)||'';
     const val=el.dataset['langOrig'+attr];
     if(translations[val])el.setAttribute(attr,lang==='en'?val:(translations[val][lang]||val));
   });
 });
}
const selector=document.getElementById('languageSelect');
if(selector){selector.addEventListener('change',()=>translate(selector.value));}
const observer=new MutationObserver(()=>{if(selector)translate(selector.value)});
observer.observe(document.body,{childList:true,subtree:true,characterData:true});
translate('en');
})();