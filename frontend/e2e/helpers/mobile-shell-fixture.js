export const mobileWidths=[320,360,375,390,414,430,768];
export const longWord='VeryLongVestanoCustomerAndStoreName'.repeat(4);
const id='00000000-0000-4000-8000-000000000001',store='00000000-0000-4000-8000-000000000011';
export async function shellFixture(page,{role='admin',signedIn=true}={}) {
  const profile={id,employee_id:longWord,name:longWord,email:longWord+'@example.test',role,active:true,store_id:role==='super_admin'?null:store};
  const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const session={access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,role:'authenticated',exp:4070908800})}.local-only`,refresh_token:'local-only',token_type:'bearer',expires_at:4070908800,expires_in:3600,user:{id,email:profile.email,aud:'authenticated',role:'authenticated',user_metadata:{}}};
  const dataset={id:1,name:longWord,original_filename:longWord+'.xlsx',customer_count:999999,uploaded_at:'2026-11-07T05:00:00Z'};
  const target={id:'target',username:longWord,email:profile.email,role:'employee',store_id:store,is_active:true,date_joined:'2026-11-07T05:00:00Z'};
  const mutations=[];
  await page.addInitScript(({session,signedIn})=>{if(signedIn)localStorage.setItem('sb-127-auth-token',JSON.stringify(session));},{session,signedIn});
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    if(!['GET','HEAD'].includes(request.method()))mutations.push(path);
    let json={};
    if(path.includes('/auth/v1/health'))json={ok:true};
    else if(path.includes('/auth/v1/user'))json=session.user;
    else if(path.includes('/auth/v1/token'))json=session;
    else if(path.includes('/rest/v1/profiles'))json=[profile];
    else if(path.includes('/rest/v1/'))json=[];
    else if(path.endsWith('/auth/legacy-login/'))json=session;
    else if(path.endsWith('/store/features/'))json={features:{dashboard:true,customers:true,sales:true,attendance:true,callbacks:true,reminders:true,reports:true,tasks:true}};
    else if(path.endsWith('/task-notifications/'))json={results:[],unreadCount:0};
    else if(path.endsWith('/callbacks/'))json={results:[],counts:{today:9999},pagination:{page:1,numPages:1,count:0}};
    else if(path.endsWith('/dashboard/')||path.endsWith('/reports/summary/'))json={totalCustomers:999999999,totalDatasets:999999,responseStats:['no_response','interested','not_interested','callback','converted'].map(value=>({value,label:value.replaceAll('_',' '),count:99999999})),recentDatasets:Array.from({length:5},(_,i)=>({...dataset,id:i+1})),payments:{totalAmount:9999999999.99,paidAmount:9999999999.99,pendingAmount:9999999999.99},sales:{totalVisits:99999999,todaysVisits:99999999,monthVisits:99999999,totalVisitExpenses:999999999.99}};
    else if(path.endsWith('/targets/'))json={results:[{id:1,monthLabel:'November 2026',converted:999999,target:999999,percentage:100,statusColor:'success'}]};
    else if(path.endsWith('/datasets/'))json={results:[dataset]};
    else if(path.endsWith('/admin/summary/'))json={users:[target],datasets:[dataset],metrics:{totalUsers:9999,totalCustomers:999999,totalDatasets:9999}};
    else if(path.endsWith('/admin/stores/'))json={results:Array.from({length:5},(_,i)=>({id:i===0?store:String(i+1),name:longWord}))};
    else if(path.endsWith('/admin/users/target/datasets/'))json={results:[dataset]};
    else if(path.endsWith('/admin/users/target/'))json=target;
    else if(path.endsWith('/admin/users/'))json={results:[target]};
    else if(path.endsWith('/tasks/'))json={results:[]};
    else if(path.endsWith('/push/config/'))json={publicKey:''};
    return route.fulfill({json,headers:{'access-control-allow-origin':'*','access-control-allow-credentials':'true'}});
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  return {mutations};
}

export async function pageOverflow(page) {
  return page.evaluate(()=>{
    const width=document.documentElement.clientWidth;
    return {width,documentWidth:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll('body *')].filter(e=>{
      const r=e.getBoundingClientRect();return r.width&&r.right>width+1&&r.left>=0&&!e.closest('.table-responsive,.offcanvas:not(.show),[hidden]');
    }).slice(0,12).map(e=>({tag:e.tagName,class:e.className,right:Math.round(e.getBoundingClientRect().right),text:e.textContent?.slice(0,55)}))};
  });
}
export async function swipe(page,{x,y,toX=x,toY}) {
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let n=1;n<=10;n++){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+(toX-x)*n/10,y:y+(toY-y)*n/10}]});
    await page.waitForTimeout(20);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(200);await cdp.detach();
}
