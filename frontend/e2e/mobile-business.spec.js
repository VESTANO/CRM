import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

const evidence=resolve(import.meta.dirname,'../../tmp/mobile-business');mkdirSync(evidence,{recursive:true});
const baseline=process.env.MOBILE_BUSINESS_BASELINE==='1';
const longName='NorthWestCustomerAccount'.repeat(8);
const longEmail='longcustomeremailaddress'.repeat(5)+'@controlled-test.example';
const longDataset='NovemberCustomerDataset'.repeat(8);
const longFile='OriginalSpreadsheetWorkbook'.repeat(6)+'.xlsx';
const longNote='Long CRM note with preserved words, callbacks, payment details and customer instructions. '.repeat(12);
const id='00000000-0000-4000-8000-000000000001',employee='00000000-0000-4000-8000-000000000002';
const choices=[{value:'no_response',label:'No Response',count:99999999},{value:'interested',label:'Interested',count:99999999},{value:'not_interested',label:'Not Interested',count:99999999},{value:'callback',label:'Callback',count:99999999},{value:'converted',label:'Converted',count:99999999}];
const dataset={id:1,name:longDataset,original_filename:longFile,customer_count:25000,owner_username:longEmail,uploaded_at:'2026-11-07T10:00:00Z',updated_at:'2026-11-07T10:00:00Z'};
const fieldRows=[{label:'Customer Name',value:longName},{label:'Email',value:longEmail},{label:'Phone',value:'001234567890'},{label:'Original Custom Column With Long Header',value:longNote}];
const record={id:1,revision:7,display_name:longName,sheet_name:'LongSheetNameWithoutSpaces',row_number:123456789,response:'callback',response_label:'Callback',callback_date:'2026-11-07',note:longNote,created_at:'2026-11-07T10:00:00Z',updated_at:'2026-11-07T10:00:00Z'};
const history={id:1,changed_by_username:longEmail,changed_at:'2026-11-07T10:00:00Z',changes:[{field:'note',label:'Note',previous:longName,updated:longNote}]};
const customerDetail={dataset,record,fieldRows,responseChoices:choices,changeHistory:[history]};
const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#405565"/><text x="60" y="290" fill="white" font-size="42">Synthetic visit evidence</text></svg>').toString('base64');
const visit={id:1,revision:3,client_name:longName,dataset_id:1,dataset_name:longDataset,client_record_id:1,manual_client:null,visit_date:'2026-11-07',meeting_time:'10:00:00',location:longNote,expense:'99999999.99',status:'converted',status_label:'Converted',payment_status:'partially_paid',payment_status_label:'Partially Paid',total_amount:'9999999999.99',paid_amount:'123456789.99',pending_amount:'9876543210.00',payment_description:longNote,note:longNote,customer_fields:fieldRows,images:Array.from({length:3},(_,i)=>({id:i+1,url:image,thumbnail_url:image,original_name:longName+`-evidence-${i+1}.jpg`}))};
const target={id:1,userId:employee,username:longEmail,month:'2026-11',monthLabel:'November 2026',target:999999999,converted:123456789,percentage:12,statusColor:'danger',needsWarning:true,lowTargetCount:12,warningMessage:longEmail+' has missed prior targets. Review progress.'};
const pages=[['customers','/customers','All Customers'],['datasets','/datasets','Customer Lists'],['dataset-detail','/datasets/1',longDataset],['dataset-rename','/datasets/1/rename','Rename Dataset'],['dataset-delete','/datasets/1/delete','Are you sure you want to delete this dataset?'],['customer-detail','/datasets/1/customers/1','Customer Details'],['customer-edit','/datasets/1/customers/1/edit','Edit Customer'],['customer-delete','/datasets/1/customers/1/delete','Are you sure you want to delete this customer?'],['callbacks','/callbacks','Callbacks'],['sales','/sales','Client Visits'],['visit-add','/sales/visits/add','Add Client Visit'],['visit-edit','/sales/visits/1/edit','Edit Client Visit'],['visit-detail','/sales/visits/1','Visit Details'],['visit-delete','/sales/visits/1/delete','Are you sure you want to delete this visit?'],['reports','/reports','Reports'],['targets-admin','/admin-panel','Admin Panel'],['import','/import','Import Excel']];

async function fixture(page) {
  const profile={id,employee_id:'QA',name:'Local QA',email:'qa@example.test',role:'admin',active:true,store_id:'00000000-0000-4000-8000-000000000011'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const session={access_token:`${encode({alg:'HS256'})}.${encode({sub:id,role:'authenticated',exp:4070908800})}.local-only`,refresh_token:'local-refresh',token_type:'bearer',expires_at:4070908800,user:{id,email:profile.email,aud:'authenticated',role:'authenticated',user_metadata:{}}};
  const errors=[],mutations=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),session);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    if(request.method()!=='GET')mutations.push({path,method:request.method()});
    let payload={results:[],pagination:{page:1,numPages:1,count:0}};
    if(path.includes('/rest/v1/profiles'))payload=[profile];
    else if(path.includes('/auth/v1/user'))payload=session.user;
    else if(path.includes('/auth/v1/'))payload={};
    else if(path.endsWith('/task-notifications/'))payload={results:[],unreadCount:0};
    else if(path.endsWith('/dashboard/'))payload={totalDatasets:99999999,totalCustomers:999999999,responseStats:choices,recentDatasets:[dataset],payments:{},sales:{}};
    else if(path.endsWith('/sales/report/'))payload={totalVisits:999999999,totalExpenses:9999999999.99,activeMonths:999999,statuses:choices,recentMonths:Array.from({length:6},(_,i)=>({key:`2026-${String(i+6).padStart(2,'0')}`,label:['Jun','Jul','Aug','Sep','Oct','Nov'][i],count:123456789+i}))};
    else if(path.endsWith('/sales/summary/'))payload={totalVisits:999999999,todaysVisits:99999999,monthVisits:99999999,totalVisitExpenses:9999999999.99};
    else if(path.endsWith('/sales/visits/1/'))payload=visit;
    else if(path.endsWith('/sales/visits/'))payload={results:Array.from({length:5},(_,i)=>({...visit,id:i+1})),pagination:{page:1,numPages:5000,count:25000}};
    else if(path.endsWith('/sales/clients/'))payload={results:[{id:1,label:longName}],pagination:{page:1,hasMore:true}};
    else if(path.endsWith('/datasets/1/customers/1/'))payload=customerDetail;
    else if(path.endsWith('/datasets/1/'))payload={dataset,responseStats:choices,responseChoices:choices,filters:{filteredCount:25000,active:false},pagination:{page:1,numPages:500,count:25000,pageRange:[1,2,3,4,5,499,500],hasPrevious:false,hasNext:true,nextPage:2},recordsBySheet:[{sheetName:record.sheet_name,columns:fieldRows.map((f,i)=>({id:i+1,originalName:f.label,fieldKey:'field'+i})),records:Array.from({length:5},(_,i)=>({record:{...record,id:i+1},values:fieldRows.map(f=>f.value)}))}]};
    else if(path.endsWith('/datasets/'))payload={results:Array.from({length:6},(_,i)=>({...dataset,id:i+1}))};
    else if(path.endsWith('/customers/'))payload={results:Array.from({length:5},(_,i)=>({record:{...record,id:i+1},datasetId:1,datasetName:longDataset,fieldRows})),statusOptions:choices,totalCount:25000,searchQuery:'',pagination:{page:1,numPages:500,count:25000,hasPrevious:false,hasNext:true,nextPage:2}};
    else if(path.endsWith('/callbacks/'))payload={results:Array.from({length:5},(_,i)=>({id:i+1,revision:7,customerName:longName,datasetId:1,datasetName:longDataset,phone:'001234567890',callbackDate:'2026-11-07',status:'callback',statusLabel:'Callback',note:longNote})),counts:{today:999999999,tomorrow:999999999,total:999999999,calledBack:999999999},filters:{},outcomeChoices:choices.filter(c=>c.value!=='callback'),pagination:{page:1,numPages:500,count:25000}};
    else if(path.endsWith('/admin/targets/'))payload=[target];
    else if(path.endsWith('/targets/'))payload={results:[target]};
    else if(path.endsWith('/admin/summary/'))payload={users:[{id:employee,username:longEmail,email:longEmail,is_admin:false,is_active:true,dataset_count:999999,customer_count:999999999,date_joined:'2026-11-07T10:00:00Z'}],metrics:{totalUsers:1,activeUsers:1,totalDatasets:6,totalCustomers:25000},recentDatasets:[dataset],recentUsers:[{id:employee,username:longEmail,email:longEmail,date_joined:'2026-11-07T10:00:00Z'}]};
    return route.fulfill({json:payload,headers:{'access-control-allow-origin':'*','access-control-allow-credentials':'true'}});
  });
  return {errors,mutations};
}

async function geometry(page) {
  return page.locator('.content-wrap').evaluate(root=>{
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';};
    const outside=[...root.querySelectorAll('*')].filter(el=>visible(el)&&!el.closest('table,svg,.modal,.table-responsive,.offcanvas,.reports-trend-markers,.customer-status-tabs')&&!['path','svg','HR','BR'].includes(el.tagName)).map(el=>({el,r:el.getBoundingClientRect()})).filter(({r})=>r.left<-.6||r.right>innerWidth+.6).slice(0,15).map(({el,r})=>({tag:el.tagName,class:el.className,text:el.textContent.slice(0,70),left:r.left,right:r.right,width:r.width}));
    const clipped=[...root.querySelectorAll('h1,h2,h3,p,dd,.badge,.summary-value,.reports-summary-value,.reports-breakdown-count,.column-list li,.reports-trend-marker')].filter(el=>visible(el)&&!el.closest('table')).filter(el=>el.scrollWidth>el.clientWidth+2&&el.clientWidth>0).map(el=>({tag:el.tagName,class:el.className,text:el.textContent.slice(0,70),client:el.clientWidth,scroll:el.scrollWidth})).slice(0,15);
    return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,outside,clipped,tables:[...root.querySelectorAll('.table-responsive')].map(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth,maxCellWidth:Math.max(0,...[...el.querySelectorAll('th,td')].filter(cell=>cell.dataset.label!=='Actions'&&!cell.classList.contains('actions-cell')).map(cell=>cell.getBoundingClientRect().width)),overflow:getComputedStyle(el).overflowX})),bodyOverflow:getComputedStyle(document.body).overflow};
  });
}

async function swipe(page,from,to) {
  const session=await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:from.x,y:from.y,id:1}]});
  for(let i=1;i<=10;i++){await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/10,y:from.y+(to.y-from.y)*i/10,id:1}]});await page.waitForTimeout(16);}
  await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(150);await session.detach();
}

for(const width of [320,360,375,390,414,430,768,1440])test(`business page layout matrix at ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:844});const {errors}=await fixture(page);const results=[];
  for(const [name,path,heading] of pages){
    await page.goto(path);await expect(page.getByRole('heading',{name:heading,exact:true}).first()).toBeVisible();
    if(name==='import'){
      await page.getByLabel('Dataset name',{exact:true}).fill(longDataset);
      const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([fieldRows.map(f=>f.label),fieldRows.map(f=>f.value)]),'LongSheetWithoutSpaces');
      await page.getByLabel('Excel file').setInputFiles({name:longFile,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})});
      await page.getByRole('button',{name:'Inspect Excel',exact:true}).click();await expect(page.getByRole('heading',{name:'Workbook Summary',exact:true})).toBeVisible();
    }
    if(name==='reports'){
      for(const card of await page.locator('.reports-summary-grid .summary-card,.reports-chart-reveal').all())await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);await page.evaluate(()=>window.scrollTo(0,0));
    }
    await page.waitForTimeout(70);const dimensions=await geometry(page);results.push({page:name,...dimensions});
    if([320,390,768,1440].includes(width))await page.screenshot({path:resolve(evidence,`${baseline?'before':'after'}-${width}-${name}.png`),fullPage:true});
    if(!baseline){expect.soft(dimensions.documentWidth,`${name} document overflow`).toBeLessThanOrEqual(width+1);expect.soft(dimensions.outside,`${name} content outside viewport`).toEqual([]);expect.soft(dimensions.clipped,`${name} clipped text`).toEqual([]);if(width<=768)for(const table of dimensions.tables)expect.soft(table.maxCellWidth,`${name} unbounded text column`).toBeLessThanOrEqual(600);}
  }
  writeFileSync(resolve(evidence,`${baseline?'before':'after'}-${width}.json`),JSON.stringify(results,null,2));
  expect(errors).toEqual([]);await testInfo.attach(`layout-${width}`,{body:Buffer.from(JSON.stringify(results)),contentType:'application/json'});
});

test('business tables, long forms, callback and target dialogs and images accept actual touch gestures',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});const {errors,mutations}=await fixture(page);const results=[];
  for(const path of ['/customers','/datasets','/datasets/1','/callbacks','/sales']){
    await page.goto(path);const table=page.locator('.table-responsive').filter({has:page.locator('tbody tr')}).first();await expect(table).toBeVisible();await table.scrollIntoViewIfNeeded();
    const box=await table.boundingBox(),y=Math.max(140,Math.min(700,box.y+Math.min(80,box.height/2)));
    await swipe(page,{x:Math.min(365,box.x+box.width-15),y},{x:Math.max(25,box.x+15),y});
    const scroll=await table.evaluate(el=>({left:el.scrollLeft,width:el.clientWidth,scrollWidth:el.scrollWidth}));results.push({path,...scroll});if(!baseline)expect.soft(scroll.left,`${path} touch horizontal table scroll`).toBeGreaterThan(5);
  }
  await page.goto('/customers');const tabs=page.getByRole('navigation',{name:'Filter customers by status'});await expect(tabs).toBeVisible();const tabsBox=await tabs.boundingBox();
  for(let i=0;i<3;i++)await swipe(page,{x:tabsBox.x+tabsBox.width-15,y:tabsBox.y+tabsBox.height/2},{x:tabsBox.x+15,y:tabsBox.y+tabsBox.height/2});
  const statusScroll=await tabs.evaluate(el=>el.scrollLeft);results.push({page:'customer-status-tabs',scrollLeft:statusScroll});if(!baseline)expect.soft(statusScroll).toBeGreaterThan(5);
  await page.goto('/sales/visits/add');await expect(page.getByRole('heading',{name:'Add Client Visit'})).toBeVisible();await swipe(page,{x:195,y:700},{x:195,y:240});const scrollY=await page.evaluate(()=>window.scrollY);results.push({page:'visit-add',scrollY});if(!baseline)expect.soft(scrollY,'visit form vertical touch scroll').toBeGreaterThan(20);
  await page.goto('/callbacks');await page.getByRole('button',{name:'Mark Called Back',exact:true}).first().click();const callbackDialog=page.getByRole('dialog');await expect(callbackDialog).toBeVisible();const callbackBox=await callbackDialog.locator('.modal-content').boundingBox();results.push({page:'callback-dialog',box:callbackBox});if(!baseline){expect.soft(callbackBox.width).toBeLessThanOrEqual(390);expect.soft(callbackBox.height).toBeLessThanOrEqual(844);}await callbackDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto('/admin-panel');await page.getByRole('button',{name:'Manage Targets',exact:true}).click();const targetDialog=page.locator('.modal.d-block');await expect(targetDialog).toBeVisible();const targetBox=await targetDialog.locator('.modal-content').boundingBox();results.push({page:'target-dialog',box:targetBox});if(!baseline){expect.soft(targetBox.width).toBeLessThanOrEqual(390);expect.soft(targetBox.height).toBeLessThanOrEqual(844);}await targetDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto('/sales/visits/1');await page.getByRole('button',{name:'Open visit image 1',exact:true}).tap();const preview=page.getByRole('dialog');await expect(preview).toBeVisible();await expect(preview.locator('img')).toBeVisible();const imageBox=await preview.locator('img').boundingBox();results.push({page:'image-preview',box:imageBox});if(!baseline){expect.soft(imageBox.width).toBeLessThanOrEqual(390);expect.soft(imageBox.height).toBeLessThanOrEqual(844);}await preview.getByRole('button',{name:'Next image',exact:true}).tap();await expect(preview.locator('img')).toHaveAttribute('alt',/Visit image 2/);await preview.getByRole('button',{name:'Previous image',exact:true}).tap();await expect(preview.locator('img')).toHaveAttribute('alt',/Visit image 1/);await preview.getByRole('button',{name:/Close/}).tap();
  expect(mutations).toEqual([]);expect(errors).toEqual([]);writeFileSync(resolve(evidence,`${baseline?'before':'after'}-touch.json`),JSON.stringify(results,null,2));await testInfo.attach('touch-evidence',{body:Buffer.from(JSON.stringify(results)),contentType:'application/json'});
});

test('business dialogs remain reachable in a short viewport and release touch scrolling',async({page})=>{
  await page.setViewportSize({width:390,height:420});const {errors,mutations}=await fixture(page);const results=[];
  const openAndCheck=async(path,trigger,name)=>{
    await page.goto(path);await page.getByRole('button',{name:trigger,exact:true}).first().click();const dialog=page.getByRole('dialog',{name,exact:true});await expect(dialog).toBeVisible();
    const box=await dialog.locator('.modal-content').boundingBox();results.push({name,box});
    if(!baseline){expect.soft(box.y).toBeGreaterThanOrEqual(0);expect.soft(box.y+box.height).toBeLessThanOrEqual(421);await expect(page.locator('body')).toHaveClass(/crm-dialog-open/);}
    const body=dialog.locator('.modal-body');const dimensions=await body.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
    if(dimensions.scroll>dimensions.height+20){const b=await body.boundingBox();await swipe(page,{x:b.x+b.width*.65,y:Math.min(345,b.y+b.height-15)},{x:b.x+b.width*.65,y:Math.max(100,b.y+15)});const scrolled=await body.evaluate(el=>el.scrollTop);results.push({name,body:dimensions,touchScroll:scrolled});if(!baseline)expect.soft(scrolled).toBeGreaterThan(5);}
    return dialog;
  };
  let dialog=await openAndCheck('/callbacks','Mark Called Back','Complete Callback');await page.keyboard.press('Escape');if(!baseline)await expect(dialog).toHaveCount(0);else await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  dialog=await openAndCheck('/datasets/1/customers/1/edit','Change date','Set Callback Date');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  dialog=await openAndCheck('/admin-panel','Manage Targets','Edit Dataset Target');await expect(dialog.getByLabel('Target Month')).toBeVisible();await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Assign Task',exact:true}).click();dialog=page.getByRole('dialog',{name:'Assign Task',exact:true});await expect(dialog).toBeVisible();
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=200;canvas.height=150;canvas.getContext('2d').fillRect(0,0,200,150);return canvas.toDataURL('image/png').split(',')[1];});
  await dialog.locator('input[type=file]').setInputFiles({name:longName+'-before.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await expect(dialog.locator('.task-photo-thumbnail').first()).toBeVisible();
  const body=dialog.locator('.modal-body'),b=await body.boundingBox();await swipe(page,{x:b.x+b.width*.65,y:Math.min(345,b.y+b.height-15)},{x:b.x+b.width*.65,y:Math.max(100,b.y+15)});
  const taskScroll=await body.evaluate(el=>el.scrollTop);results.push({name:'Assign Task',touchScroll:taskScroll});if(!baseline)expect.soft(taskScroll).toBeGreaterThan(5);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.locator('.modal-backdrop,.crm-confirmation-backdrop')).toHaveCount(0);
  if(!baseline)await expect(page.locator('body')).not.toHaveClass(/crm-dialog-open/);
  await page.setViewportSize({width:390,height:844});await page.goto('/sales/visits/add');await swipe(page,{x:195,y:700},{x:195,y:240});if(!baseline)expect.soft(await page.evaluate(()=>window.scrollY)).toBeGreaterThan(20);
  expect(errors).toEqual([]);expect(mutations).toEqual([]);writeFileSync(resolve(evidence,`${baseline?'before':'after'}-short-dialogs.json`),JSON.stringify(results,null,2));
});

test('business SPA forward navigation starts at the heading and browser back restores the prior page',async({page})=>{
  await page.setViewportSize({width:390,height:844});const {errors}=await fixture(page);await page.goto('/customers');await expect(page.getByRole('heading',{name:'All Customers'})).toBeVisible();
  await swipe(page,{x:195,y:700},{x:195,y:180});await swipe(page,{x:195,y:700},{x:195,y:180});
  const link=page.getByRole('link',{name:'View',exact:true}).first();await link.scrollIntoViewIfNeeded();const prior=await page.evaluate(()=>window.scrollY);await link.click();await expect(page).toHaveURL(/datasets\/1\/customers\/1$/);await expect(page.getByRole('heading',{name:'Customer Details'})).toBeVisible();
  await page.waitForTimeout(180);const forward=await page.evaluate(()=>window.scrollY);await page.goBack();await expect(page.getByRole('heading',{name:'All Customers'})).toBeVisible();await page.waitForTimeout(200);const back=await page.evaluate(()=>window.scrollY);
  writeFileSync(resolve(evidence,`${baseline?'before':'after'}-history.json`),JSON.stringify({prior,forward,back},null,2));
  if(!baseline){expect.soft(forward).toBeLessThanOrEqual(1);expect.soft(Math.abs(back-prior)).toBeLessThanOrEqual(60);}expect(errors).toEqual([]);
});
