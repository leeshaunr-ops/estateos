(()=>{
  const update=()=>{
    const clientView=location.pathname==='/client-login'||location.search.includes('invite=')||document.querySelector('.resident-sidebar');
    document.documentElement.classList.toggle('client-view',Boolean(clientView));
  };
  new MutationObserver(update).observe(document.body,{childList:true,subtree:true});
  update();
})();
