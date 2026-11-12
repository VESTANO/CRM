import { test, expect } from '@playwright/test';

// Browser transport fixtures exercise the real UI, independently of the native
// and PGlite suites that verify the actual SQL and current Edge handlers.
async function fixture(page, business) {
  const id='00000000-0000-4000-8000-000000000001';
  const profile={id,employee_id:'QA',name:'Local QA',email:'qa@example.test',role:'admin',active:true,store_id:'00000000-0000-4000-8000-000000000011'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const session={access_token:`${encode({alg:'HS256'})}.${encode({sub:id,role:'authenticated',exp:4070908800})}.local-only`,refresh_token:'local-refresh',token_type:'bearer',expires_at:4070908800,user:{id,email:profile.email,aud:'authenticated',role:'authenticated',user_metadata:{}}};
  const reads=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),session);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;reads.push({path,params:Object.fromEntries(url.searchParams)});
    const send=(json,status=200)=>route.fulfill({status,json,headers:{'access-control-allow-origin':'*','access-control-allow-credentials':'true'}});
    if(route.request().method()==='OPTIONS') return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    if(await business({path,params:url.searchParams,send,route}))return;
    let payload={results:[],pagination:{page:1,numPages:1,count:0}};
    if(path.includes('/rest/v1/profiles'))payload=[profile];
    else if(path.includes('/auth/v1/user'))payload=session.user;
    else if(path.includes('/auth/v1/'))payload={};
    else if(path.endsWith('/store/features/'))payload={features:{dashboard:true,customers:true,sales:true,attendance:true,callbacks:true,reminders:true,reports:true,tasks:true}};
    else if(path.endsWith('/dashboard/')||path.endsWith('/reports/summary/'))payload={totalDatasets:0,totalCustomers:0,responseStats:[],recentDatasets:[],payments:{},sales:{}};
    else if(path.endsWith('/task-notifications/'))payload={results:[],unreadCount:0};
    else if(path.endsWith('/sales/summary/'))payload={totalVisits:12,todaysVisits:0,monthVisits:12,totalVisitExpenses:0};
    else if(path.endsWith('/sales/report/'))payload={totalVisits:0,totalExpenses:0,activeMonths:0,statuses:[],recentMonths:[]};
    return send(payload);
  });
  return {reads,errors};
}
const visit=id=>({id,client_name:'Synthetic '+id,dataset_name:'West',visit_date:'2026-11-07',meeting_time:'10:00:00',location:'QA',expense:0,status:'healthy',status_label:'Healthy',note:''});
const history=id=>({id,changed_by_username:'Employee',changed_at:'2026-11-07T10:00:00Z',changes:[{field:'note',label:'Note',previous:'Before '+id,updated:'After '+id}]});
const detail=(id,entries=[],cursor=null)=>({dataset:{id:1,name:'Local Dataset'},record:{id,display_name:'Customer '+id,sheet_name:'Leads',row_number:id+1,response:'interested',response_label:'Interested',note:'Customer '+id},fieldRows:[{label:'Name',value:'Customer '+id}],changeHistory:entries,changeHistoryNextCursor:cursor});
const spaNavigate=(page,path)=>page.evaluate(path=>{window.history.pushState(null,'',path);window.dispatchEvent(new PopStateEvent('popstate'));},path);

test('Phase 4 performance: sales pages and filters query the server and ignore stale responses',async({page})=>{
  let releaseOld;let oldStarted=false;
  const {reads,errors}=await fixture(page,async({path,params,send})=>{
    if(!path.endsWith('/sales/visits/'))return false;
    const query=params.get('q')||'',number=Number(params.get('page')||1);
    if(query==='Old'){oldStarted=true;await new Promise(resolve=>{releaseOld=resolve;});}
    const results=query?[{...visit(99),client_name:query+' result'}]:Array.from({length:5},(_,i)=>visit((number-1)*5+i+1));
    await send({results,pagination:{page:number,numPages:query?1:3,count:query?1:12}});return true;
  });
  await page.goto('/sales');await expect(page.locator('.sales-visits-table tbody tr')).toHaveCount(5);
  await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.sales-visits-table tbody tr').first()).toContainText('Synthetic 6');
  expect(reads.some(r=>r.path.endsWith('/sales/visits/')&&r.params.page==='2')).toBe(true);
  await page.getByLabel('Client Name',{exact:true}).fill('Old');await page.getByRole('button',{name:'Filter',exact:true}).click();
  await expect.poll(()=>oldStarted).toBe(true);
  await page.getByLabel('Client Name',{exact:true}).fill('Latest');await page.getByRole('button',{name:'Filter',exact:true}).click();
  await expect(page.locator('.sales-visits-table tbody')).toContainText('Latest result');
  releaseOld();await page.waitForTimeout(100);await expect(page.locator('.sales-visits-table tbody')).toContainText('Latest result');
  expect(reads.some(r=>r.path.endsWith('/sales/visits/')&&r.params.q==='Latest'&&!r.params.page)).toBe(true);expect(errors).toEqual([]);
});

test('Phase 4 performance: customer history loads another cursor page, retries and deduplicates',async({page})=>{
  let attempts=0;
  const {reads,errors}=await fixture(page,async({path,send})=>{
    if(path.endsWith('/datasets/1/customers/1/')){await send(detail(1,[history(2)],{time:'2026-11-07T10:00:00+00:00',id:2}));return true;}
    if(path.endsWith('/datasets/1/customers/1/history/')){attempts+=1;if(attempts===1)await send({detail:'Offline retry'},503);else await send({entries:[history(2),history(1)],nextCursor:null});return true;}
    return false;
  });
  await page.goto('/datasets/1/customers/1');
  await expect(page.locator('.customer-change-table tbody tr')).toHaveCount(1);
  await page.getByRole('button',{name:'Load earlier changes'}).click();await expect(page.getByRole('alert')).toContainText('Unable to load earlier changes');
  await page.getByRole('button',{name:'Load earlier changes'}).click();await expect(page.locator('.customer-change-table tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Load earlier changes'})).toHaveCount(0);
  const requests=reads.filter(r=>r.path.endsWith('/history/'));expect(requests).toHaveLength(2);expect(requests[1].params.before_id).toBe('2');expect(requests[1].params.before_time).toBe('2026-11-07T10:00:00+00:00');expect(errors).toEqual([]);
});

test('Phase 4 performance: slow prior customer detail cannot overwrite the next route',async({page})=>{
  let releaseFirst,started=false;
  const {errors}=await fixture(page,async({path,send})=>{
    if(path.endsWith('/datasets/1/customers/1/')){started=true;await new Promise(resolve=>{releaseFirst=resolve;});await send(detail(1));return true;}
    if(path.endsWith('/datasets/1/customers/2/')){await send(detail(2));return true;}
    return false;
  });
  await page.goto('/datasets/1/customers/1');await expect.poll(()=>started).toBe(true);
  await spaNavigate(page,'/datasets/1/customers/2');await expect(page.getByText('Customer 2',{exact:true}).first()).toBeVisible();
  releaseFirst();await page.waitForTimeout(100);await expect(page.getByText('Customer 2',{exact:true}).first()).toBeVisible();await expect(page.getByText('Customer 1',{exact:true})).toHaveCount(0);expect(errors).toEqual([]);
});

test('Phase 4 performance: client selector retains an edit client outside page one and loads more',async({page})=>{
  const {reads,errors}=await fixture(page,async({path,params,send})=>{
    if(path.endsWith('/datasets/')){await send({results:[{id:1,name:'Local Dataset'}]});return true;}
    if(path.endsWith('/sales/visits/7/')){await send({...visit(7),revision:3,dataset_id:1,client_record_id:24999,manual_client:null});return true;}
    if(path.endsWith('/sales/clients/')){const number=Number(params.get('page')||1);const results=Array.from({length:50},(_,i)=>({id:(number-1)*50+i+1,label:'Client '+((number-1)*50+i+1)}));if(number===1&&params.get('selected')==='24999')results.unshift({id:24999,label:'Selected distant client'});await send({results,pagination:{page:number,hasMore:number===1}});return true;}
    return false;
  });
  await page.goto('/sales/visits/7/edit');await expect(page.locator('select[name=customer]')).toHaveValue('24999');
  await expect(page.locator('select[name=customer] option:checked')).toHaveText('Selected distant client');
  await page.getByRole('button',{name:'Load more clients'}).click();await expect(page.locator('select[name=customer] option[value="51"]')).toHaveCount(1);
  await expect(page.locator('select[name=customer]')).toHaveValue('24999');
  expect(reads.some(r=>r.path.endsWith('/sales/clients/')&&r.params.selected==='24999')).toBe(true);expect(reads.some(r=>r.path.endsWith('/sales/clients/')&&r.params.page==='2')).toBe(true);expect(errors).toEqual([]);
});

test('Phase 4 performance: slow prior visit detail cannot overwrite the next edit route',async({page})=>{
  let releaseFirst,started=false;
  const {errors}=await fixture(page,async({path,send})=>{
    if(path.endsWith('/datasets/')){await send({results:[]});return true;}
    if(path.endsWith('/sales/visits/7/')){started=true;await new Promise(resolve=>{releaseFirst=resolve;});await send({...visit(7),manual_client:{client_name:'Old visit'},revision:1});return true;}
    if(path.endsWith('/sales/visits/8/')){await send({...visit(8),manual_client:{client_name:'Current visit'},revision:2});return true;}
    return false;
  });
  await page.goto('/sales/visits/7/edit');await expect.poll(()=>started).toBe(true);
  await spaNavigate(page,'/sales/visits/8/edit');await expect(page.getByLabel('Client Name',{exact:true})).toHaveValue('Current visit');
  releaseFirst();await page.waitForTimeout(100);await expect(page.getByLabel('Client Name',{exact:true})).toHaveValue('Current visit');expect(errors).toEqual([]);
});
