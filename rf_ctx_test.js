const puppeteer=require('puppeteer');
(async()=>{
 const px=process.argv[2];
 const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--proxy-server='+px,'--autoplay-policy=no-user-gesture-required'],timeout:25000});
 try{
  const p=await browser.newPage();
  await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  const resp=await p.goto('https://redeflixapi.click/filme/687163',{waitUntil:'domcontentloaded',timeout:60000});
  console.log('page',resp.status());
  await new Promise(r=>setTimeout(r,1500));
  const out=await p.evaluate(async()=>{
    const fast=window.fastLaunchTickets&&window.fastLaunchTickets.default;
    const tick=window.playbackResolveTicket;
    const headers={'Content-Type':'application/json','Accept':'application/json','X-Requested-With':'RedeFlixPlayer'};
    async function post(url,body){const r=await fetch(url,{method:'POST',credentials:'same-origin',headers,body:JSON.stringify(body)});return {status:r.status,json:await r.json().catch(()=>null)}}
    const res={fast:!!fast,tick:!!tick};
    if(fast){const r=await post('/playerkys/source.php',{ticket:fast});res.source={status:r.status,url:r.json&&r.json.url?r.json.url.slice(0,100):null,err:r.json&&r.json.error}}
    if(!res.source||!res.source.url){
      const r2=await post('/playback-resolve.php',{ticket:tick,server:'default'});
      res.resolve={status:r2.status,url:r2.json&&r2.json.url?r2.json.url.slice(0,100):null,launch:!!(r2.json&&r2.json.launchTicket),err:r2.json&&r2.json.error};
      if(r2.json&&r2.json.launchTicket){const r3=await post('/playerkys/source.php',{ticket:r2.json.launchTicket});res.source2={status:r3.status,url:r3.json&&r3.json.url?r3.json.url.slice(0,100):null,err:r3.json&&r3.json.error}}
      if(r2.json&&r2.json.url)res.directUrl=r2.json.url.slice(0,100);
    }
    return res;
  });
  console.log(JSON.stringify(out,null,1));
 }catch(e){console.log('ERR',e.message.slice(0,150))}finally{await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
