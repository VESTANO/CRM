import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
const id='00000000-0000-4000-8000-000000000001';
const profile={id,employee_id:'QAADMIN',name:'Local QA',email:'qa@example.test',role:'admin',active:true,store_id:'00000000-0000-4000-8000-000000000011'};
const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const token=`${encode({alg:'HS256',typ:'JWT'})}.${encode({sub:id,role:'authenticated',exp:4070908800})}.fake-local-signature`;
const session={access_token:token,refresh_token:'local-refresh',token_type:'bearer',expires_in:3600,expires_at:4070908800,user:{id,email:profile.email,aud:'authenticated',role:'authenticated',user_metadata:{}}};
const choices=[{value:'no_response',label:'No Response'},{value:'interested',label:'Interested'},{value:'callback',label:'Callback'}];
const record={id:1,display_name:'Alice',sheet_name:'Leads',row_number:2,original_data:{name:'Alice'},response:'no_response',note:''};
const timesheet={id:'00000000-0000-4000-8000-000000000044',user_id:id,employee_id:'QAADMIN',employee_name:'Local QA',work_date:'2026-11-07',project:'Display',details:'Arrange display',total_hours:8,approval_status:'Submitted'};
const pageErrors=new WeakMap();
test.beforeEach(async({page})=>{const errors=[];pageErrors.set(page,errors);page.on('pageerror',error=>errors.push(error.message));});
test.afterEach(async({page})=>{expect(pageErrors.get(page),'uncaught browser JavaScript errors').toEqual([]);});
async function fixture(page,{signedIn=true,role='admin'}={}) {
  const mutations=[]; let reviewed=false,completedCallback=false,timesheetReviewed=false;
  const localRecord={...record};
  const reminders=[{id:1,text:'Existing upcoming',reminder_at:'2099-01-01T12:00:00Z'},{id:2,text:'Existing due',reminder_at:'2000-01-01T12:00:00Z'}];
  const managedUser={id:'target',username:'GLOBAL2',email:'global2@example.test',role:'super_admin',store_id:null,is_active:true};
  await page.addInitScript(({session,signedIn})=>{if(signedIn)localStorage.setItem('sb-127-auth-token',JSON.stringify(session));},{session,signedIn});
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
    let payload={};
    if(method==='OPTIONS') return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    if(method!=='GET') mutations.push({path,body:request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : request.postData()});
    if(path.includes('/auth/v1/token')) payload=session;
    else if(path.includes('/auth/v1/user')) payload=session.user;
    else if(path.includes('/auth/v1/logout')) payload={};
    else if(path.includes('/rest/v1/profiles')) payload=[{...profile,role,store_id:role==='super_admin'?null:profile.store_id}];
    else if(path.endsWith('/admin/users/target/')){if(method==='PATCH')Object.assign(managedUser,request.postDataJSON());payload=managedUser;}
    else if(path.endsWith('/admin/users/'))payload={results:[managedUser]};
    else if(path.endsWith('/admin/stores/'))payload={results:[{id:profile.store_id,name:'Store A'},{id:'00000000-0000-4000-8000-000000000012',name:'Store B'}]};
    else if(path.includes('/rest/v1/timesheet_entries')) payload=timesheetReviewed?[]:[timesheet];
    else if(path.endsWith('/rpc/review_timesheet_entry')) {timesheetReviewed=true;payload={...timesheet,approval_status:'Rejected'};}
    else if(path.endsWith('/rpc/create_timesheet_entry')) payload=timesheet;
    else if(path.endsWith('/reminders/')) {
      if(method==='POST') reminders.push({id:3,...request.postDataJSON()});
      payload=method==='GET'?{results:reminders}:{id:3,...request.postDataJSON()};
    }
    else if(path.endsWith('/reminders/3/')) {Object.assign(reminders.find(r=>r.id===3),request.postDataJSON());payload=reminders.find(r=>r.id===3);}
    else if(path.endsWith('/auth/legacy-login/')) payload=session;
    else if(path.endsWith('/store/features/')) payload={features:{dashboard:true,customers:true,sales:true,attendance:true,callbacks:true,reminders:true,reports:true,tasks:true}};
    else if(path.endsWith('/task-notifications/')) payload={results:[],unreadCount:0};
    else if(path.endsWith('/admin/tasks/')) payload={results:[{id:1,title:'Inspect display',status:reviewed?'done':'submitted',assignee_username:'EMPLOYEE',assigned_by_username:'QAADMIN',created_at:'2026-11-01',assignment_images:[],completion_images:[],current_submission:{id:11,note:'Evidence ready',images:[]},submissions:[]}]};
    else if(path.endsWith('/admin/tasks/1/')){reviewed=true;payload={};}
    else if(path.endsWith('/overtime/')) payload={requests:[{id:1,employeeName:'Employee',workDate:'2026-11-01',officialEndTime:'17:30',declaredLeaveTime:'2026-11-01T19:00:00Z',actualPunchOut:'2026-11-01T19:00:00Z',requestedMinutes:90,status:'pending'}],approvedMinutes:0};
    else if(path.includes('/overtime/1/')) payload={};
    else if(path.endsWith('/callbacks/')) payload={results:completedCallback?[]:[{id:1,datasetId:1,datasetName:'Imported QA',customerName:'Alice',status:'callback',callbackDate:'2026-11-07'}],counts:{today:completedCallback?0:1},filters:{},outcomeChoices:choices,pagination:{page:1,numPages:2,count:51}};
    else if(path.endsWith('/callbacks/1/complete/')){completedCallback=true;payload={};}
    else if(path.endsWith('/datasets/1/customers/1/')){
      if(method==='PATCH') Object.assign(localRecord,request.postDataJSON());
      payload={dataset:{id:1,name:'Imported QA'},record:localRecord,fieldRows:[{label:'Name',value:'Alice'}],responseChoices:choices,changeHistory:[]};
    }
    else if(path.endsWith('/customers/')) payload={results:[{record:localRecord,datasetId:1,datasetName:'Imported QA',fieldRows:[{label:'Name',value:'Alice'}]}],statusOptions:choices,pagination:{page:1,numPages:1,count:1},totalCount:1};
    else if(path.endsWith('/import/start/')) payload={id:'00000000-0000-4000-8000-000000000099'};
    else if(path.endsWith('/batch/')) payload={staged:2};
    else if(path.endsWith('/commit/')) payload={dataset:{id:1}};
    else if(/\/datasets\/[12]\/$/.test(path)) payload={dataset:{id:Number(path.split('/').at(-2)),name:path.endsWith('/2/')?'Second QA':'Imported QA',customer_count:2},recordsBySheet:[],responseChoices:[],responseStats:[],filters:{},pagination:{page:1,numPages:1,pageRange:[1]}};
    else if(path.endsWith('/datasets/')) payload={results:[{id:1,name:'Imported QA',customer_count:2},{id:2,name:'Second QA',customer_count:3}]};
    else if(path.endsWith('/targets/')) payload={results:[]};
    else if(path.endsWith('/dashboard/')||path.endsWith('/reports/summary/')) payload={totalDatasets:2,totalCustomers:20,responseStats:[],recentDatasets:[],payments:{},sales:{}};
    else if(path.endsWith('/sales/report/')) payload={totalVisits:3,totalExpenses:12.35,activeMonths:1,statuses:[{value:'converted',label:'Converted',count:3}],recentMonths:Array.from({length:6},(_,i)=>({key:`2026-${String(i+6).padStart(2,'0')}`,label:`Month ${i+1}`,count:i===5?3:0}))};
    else if(path.endsWith('/tasks/1/')) payload={};
    else if(path.endsWith('/tasks/')) payload={results:role==='employee'?[{id:1,title:'Inspect display',status:'pending',created_at:'2026-11-01',assignment_images:[],completion_images:[]}]:[]};
    else payload=[];
    return route.fulfill({json:payload,headers:{'access-control-allow-origin':'*','access-control-allow-credentials':'true'}});
  });
  // There is no hosted project in these tests. Abort any accidental remote call.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  return mutations;
}
async function scrollUnlocked(page) {
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).overflow)).not.toBe('hidden');
  expect(await page.locator('.crm-confirmation-backdrop,.offcanvas-backdrop').count()).toBe(0);
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  expect(await page.evaluate(()=>scrollY)).toBeGreaterThan(0);
}
for(const width of [320,360,375,390,414,768,1024,1440]) {
  test(`${width}px task confirmation, rejection validation, focus and scrolling`,async({page})=>{
    await page.setViewportSize({width,height:740});
    const mutations=await fixture(page);
    await page.goto('/admin-panel/tasks');
    await page.getByRole('button',{name:'Reject task',exact:true}).click();
    const dialog=page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button',{name:'Confirm rejection'})).toBeDisabled();
    await dialog.getByLabel('Rejection feedback').fill('Please add a clear photo');
    await expect(dialog.getByRole('button',{name:'Confirm rejection'})).toBeEnabled();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    expect(mutations.filter(r=>r.path.endsWith('/admin/tasks/1/'))).toHaveLength(0);
    await page.getByRole('button',{name:'Approve task',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm approval'}).click();
    await expect(dialog).not.toBeVisible();
    expect(mutations.filter(r=>r.path.endsWith('/admin/tasks/1/'))).toHaveLength(1);
    if(width<992) {
      await page.getByRole('button',{name:'Open navigation menu'}).click();
      await expect(page.locator('#mobileNav')).toHaveClass(/show/);
      await page.locator('#mobileNav').getByRole('link',{name:'Dashboard',exact:true}).click();
      await expect(page).toHaveURL(/dashboard/);
      await expect(page.locator('#mobileNav')).not.toHaveClass(/show/);
      await page.goBack(); await expect(page.getByRole('heading',{name:'Assigned Tasks',exact:true})).toBeVisible();
    }
    await scrollUnlocked(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
test('workbook file input, inspect, staged upload and commit navigation',async({page})=>{
  const mutations=await fixture(page); await page.goto('/import');
  await page.getByLabel('Dataset name').fill('QA leads');
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Name','Phone'],['Alice','001234'],['Bob','009876']]),'Leads');
  await page.getByLabel('Excel file').setInputFiles({name:'qa.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(wb,{type:'buffer',bookType:'xlsx'})});
  await page.getByRole('button',{name:'Inspect Excel'}).click();
  await expect(page.getByRole('heading',{name:'Workbook Summary'})).toBeVisible();
  await page.getByRole('button',{name:'Confirm Import',exact:true}).click();
  await expect(page).toHaveURL(/datasets\/1/);
  expect(mutations.filter(r=>r.path.endsWith('/batch/'))[0].body.rows).toHaveLength(2);
  expect(mutations.filter(r=>r.path.endsWith('/commit/'))).toHaveLength(1);
});
test('overtime rejection requires a reason and sends it once',async({page})=>{
  const mutations=await fixture(page); await page.goto('/overtime');
  await page.getByRole('button',{name:'Reject',exact:true}).click();
  const dialog=page.getByRole('dialog'); await expect(dialog.getByRole('button',{name:'Confirm rejection'})).toBeDisabled();
  await dialog.getByLabel('Rejection reason').fill('Punch time does not match request');
  await dialog.getByRole('button',{name:'Confirm rejection'}).click();
  await expect(dialog).not.toBeVisible();
  expect(mutations.filter(r=>r.path.includes('/overtime/1/'))).toHaveLength(1);
});
test('login form, logout and expired-session route guard',async({page})=>{
  await fixture(page,{signedIn:false}); await page.goto('/login');
  await page.getByLabel(/Username|Employee ID/i).fill('QAADMIN'); await page.getByLabel('Password',{exact:true}).fill('local-only-password');
  await page.getByRole('button',{name:'Continue to CRM'}).click(); await expect(page).toHaveURL(/dashboard/);
  await page.locator('.app-sidebar').getByRole('button',{name:/Sign out|Logout|Log out/i}).click();
  await expect(page).toHaveURL(/login/);
  await page.goto('/admin-panel/tasks'); await expect(page).toHaveURL(/login/);
});
test('timesheet rejection dialog posts feedback through the attendance RPC',async({page})=>{
  const mutations=await fixture(page); await page.goto('/attendance/approvals');
  await page.getByRole('button',{name:'Reject',exact:true}).click();
  const dialog=page.getByRole('dialog'); await expect(dialog.getByRole('button',{name:'Confirm rejection'})).toBeDisabled();
  await dialog.getByLabel('Rejection feedback').fill('Correct the work date');
  await dialog.getByRole('button',{name:'Confirm rejection'}).click(); await expect(dialog).not.toBeVisible();
  expect(mutations.find(r=>r.path.endsWith('/rpc/review_timesheet_entry')).body.p_approval_comment).toBe('Correct the work date');
});
test('customer search, status selection, editing and callback completion',async({page})=>{
  const mutations=await fixture(page); await page.goto('/customers');
  await page.getByLabel('Search by client name').fill('Alice'); await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page).toHaveURL(/q=Alice/);
  await page.getByRole('button',{name:'Interested',exact:false}).click(); await expect(page).toHaveURL(/status=interested/);
  await page.goto('/datasets/1/customers/1/edit'); await page.getByLabel('Note',{exact:true}).fill('Contacted in local QA');
  await page.getByRole('button',{name:'Save',exact:true}).click(); await expect(page).toHaveURL(/\/datasets\/1\/customers\/1$/);
  expect(mutations.find(r=>r.path.endsWith('/datasets/1/customers/1/')).body.note).toBe('Contacted in local QA');
  await page.goto('/callbacks'); await page.getByRole('button',{name:'Next',exact:true}).click(); await expect(page).toHaveURL(/page=2/);
  await page.getByRole('button',{name:'Mark Called Back'}).click(); await page.getByLabel('New Status').selectOption('interested');
  await page.getByRole('button',{name:'Save Status'}).click(); await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(mutations.filter(r=>r.path.endsWith('/callbacks/1/complete/'))).toHaveLength(1);
});
test('dataset switching and browser history restore the requested dataset',async({page})=>{
  await fixture(page); await page.goto('/datasets');
  await page.getByRole('row').filter({hasText:'Imported QA'}).getByRole('link',{name:'Open',exact:true}).click(); await expect(page.getByRole('heading',{name:'Imported QA',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Back to Customer Lists'}).click();
  await page.getByRole('row').filter({hasText:'Second QA'}).getByRole('link',{name:'Open',exact:true}).click(); await expect(page.getByRole('heading',{name:'Second QA',exact:true})).toBeVisible();
  await page.goBack(); await page.goForward(); await expect(page.getByRole('heading',{name:'Second QA',exact:true})).toBeVisible();
});
test('employee photo preparation and evidence submission sends multipart data',async({page})=>{
  const mutations=await fixture(page,{role:'employee'}); await page.goto('/notifications');
  const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;canvas.getContext('2d').fillRect(0,0,40,40);return canvas.toDataURL('image/png').split(',')[1];});
  await page.getByLabel('After photos (optional)').setInputFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await expect(page.getByAltText(/Selected photo/)).toBeVisible();
  await page.getByLabel('Submission note (optional)').fill('Local evidence');
  await page.getByRole('button',{name:'Submit for review',exact:true}).click();
  await expect.poll(()=>mutations.filter(r=>r.path.endsWith('/tasks/1/')).length).toBe(1);
  expect(mutations.find(r=>r.path.endsWith('/tasks/1/')).body).toContain('Local evidence');
});
test('server 401 expires the current UI session',async({page})=>{
  await fixture(page); await page.goto('/dashboard');
  await expect(page.getByRole('heading',{name:/Dashboard/i}).first()).toBeVisible();
  await page.route('**/functions/v1/crm-api/api/customers/**',route=>route.fulfill({status:401,json:{detail:'Session expired'},headers:{'access-control-allow-origin':'*'}}));
  await page.goto('/customers'); await expect(page).toHaveURL(/login/);
});
test('daily timesheet form submits work and XLSX export contains the displayed hours',async({page})=>{
  const mutations=await fixture(page); await page.goto('/attendance/timesheet');
  await page.getByRole('button',{name:'+ New entry',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.locator('input[type=date]').fill('2026-11-07');
  await dialog.locator('label').filter({hasText:/^Project$/}).locator('..').locator('input').fill('Display QA');
  await dialog.locator('label').filter({hasText:/^Work details$/}).locator('..').locator('input').fill('Arrange display');
  await dialog.getByRole('button',{name:'+ Add another entry',exact:true}).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Date',{exact:true})).toHaveValue('2026-11-07');
  await expect(dialog.getByLabel('Project',{exact:true})).toHaveValue('Display QA');
  await dialog.getByLabel('Project 2',{exact:true}).fill('Follow-up QA');
  await dialog.getByLabel('Work details 2',{exact:true}).fill('Add the next work item');
  await dialog.getByRole('button',{name:'Submit 2 entries',exact:true}).click(); await expect(dialog).not.toBeVisible();
  const created=mutations.filter(r=>r.path.endsWith('/rpc/create_timesheet_entry'));
  expect(created).toHaveLength(2); expect(created[0].body.p_project).toBe('Display QA'); expect(created[1].body.p_project).toBe('Follow-up QA');
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download XLSX',exact:true}).click();
  const download=await downloading,stream=await download.createReadStream(),chunks=[];
  for await (const chunk of stream) chunks.push(chunk);
  const wb=XLSX.read(Buffer.concat(chunks),{type:'buffer'});
  const data=XLSX.utils.sheet_to_json(wb.Sheets.Timesheet);
  expect(data[0]['Employee ID']).toBe('QAADMIN'); expect(data[0]['Total hours']).toBe(8);
  expect(data[0]['Approval status']).toBe('Submitted');
});
test('timesheet groups one employee’s same-day entries into one row',async({page})=>{
  await fixture(page);
  const followUp={...timesheet,id:'00000000-0000-4000-8000-000000000045',user_id:'00000000-0000-4000-8000-000000000099',project:'Follow-up QA',details:'Add the next work item',start_time:'13:00',end_time:'17:30',total_hours:4};
  await page.route('**/rest/v1/timesheet_entries**',route=>route.fulfill({json:[timesheet,followUp],headers:{'access-control-allow-origin':'*'}}));
  await page.goto('/attendance/timesheet');
  const rows=page.locator('#timesheet-results tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator('td').first()).toHaveAttribute('rowspan','2');
  await expect(rows.first()).toContainText('Display');
  await expect(rows.nth(1)).toContainText('Follow-up QA');
});
test('reminders save and edit with denied notification permission; due/upcoming remain separate',async({page})=>{
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Browser.setPermission',{permission:{name:'notifications'},setting:'denied',origin:'http://127.0.0.1:5182'});
  const mutations=await fixture(page); await page.goto('/reminders');
  await expect(page.getByText('Existing upcoming',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Due \(/}).click(); await expect(page.getByText('Existing due',{exact:true})).toBeVisible();
  await expect(page.getByText('Existing upcoming',{exact:true})).not.toBeVisible();
  await page.getByLabel('Reminder',{exact:true}).fill('Follow up locally');
  await page.getByLabel('Date',{exact:true}).fill('2099-02-01'); await page.getByLabel('Time',{exact:true}).fill('12:00');
  await page.getByRole('button',{name:'Set Reminder',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'blocked'})).toBeVisible();
  await page.getByRole('button',{name:/Upcoming \(/}).click();
  const saved=page.locator('#reminder-3'); await saved.getByRole('button',{name:'Edit reminder'}).click();
  await page.getByLabel('Reminder',{exact:true}).fill('Edited follow up'); await page.getByRole('button',{name:'Save Changes',exact:true}).click();
  await expect(page.getByText('Edited follow up',{exact:true})).toBeVisible();
  expect(mutations.filter(r=>r.path.endsWith('/reminders/3/'))[0].body.text).toBe('Edited follow up');
});
test('global Super Admin roles are protected from in-place demotion',async({page})=>{
  await fixture(page,{role:'super_admin'}); await page.goto('/admin-panel/users/target/edit');
  const role = page.getByLabel('Role',{exact:true});
  await expect(role).toHaveValue('Super Admin');
  await expect(role).toHaveAttribute('readonly','');
  await expect(page.getByText('Super Admin is a protected global role and is managed separately from store accounts.')).toBeVisible();
  await expect(page.getByLabel('Store',{exact:true})).toHaveCount(0);
});
test('sales report renders aggregated data without requesting complete visit history',async({page})=>{
  const calls=[]; page.on('request',r=>calls.push(r.url())); await fixture(page); await page.goto('/reports');
  await expect(page.getByRole('heading',{name:'Sales Insights',exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:/Visit counts over the last six months/})).toBeVisible();
  expect(calls.some(url=>url.includes('/sales/report/'))).toBe(true);
  expect(calls.some(url=>url.includes('/sales/visits/'))).toBe(false);
});
test('manual visit retry retains its request key and displays consistent pending payment',async({page})=>{
  await fixture(page); const attempts=[];
  await page.route('**/functions/v1/crm-api/api/sales/visits/',async route=>{
    attempts.push(route.request().postData());
    await route.fulfill({status:attempts.length===1?503:201,json:attempts.length===1?{detail:'Simulated lost response; retry safely.'}:{id:3},headers:{'access-control-allow-origin':'*'}});
  });
  await page.route('**/functions/v1/crm-api/api/sales/visits/3/',route=>route.fulfill({json:{id:3,client_name:'Synthetic client',visit_date:'2026-11-07',status:'converted',status_label:'Converted',payment_status:'partially_paid',payment_status_label:'Partially Paid',total_amount:100.25,paid_amount:30.10,pending_amount:70.15,expense:2.75,manual_client:{client_name:'Synthetic client'},images:[]},headers:{'access-control-allow-origin':'*'}}));
  await page.goto('/sales/visits/add'); await page.getByRole('button',{name:'New / Manual Client'}).click();
  await page.getByLabel('Client Name',{exact:true}).fill('Synthetic client'); await page.getByLabel('Visit Date',{exact:true}).fill('2026-11-07');
  await page.locator('select[name=status]').selectOption('converted');
  await page.getByLabel('Total Amount',{exact:true}).fill('100.25'); await page.getByLabel('Paid Amount',{exact:true}).fill('30.10');
  await expect(page.getByText('₹70.15',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create Visit',exact:true}).click();
  await expect(page.getByText('Simulated lost response; retry safely.')).toBeVisible();
  await page.getByRole('button',{name:'Create Visit',exact:true}).click(); await expect(page).toHaveURL(/sales\/visits\/3$/);
  const keys=attempts.map(body=>body.match(/name="request_key"\r\n\r\n([^\r\n]+)/)?.[1]);
  expect(keys).toHaveLength(2); expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/); expect(keys[1]).toBe(keys[0]);
});
test.describe('mobile touch emulation',()=>{
  test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  test('repeated drawer and dialog transitions leave touch scrolling available',async({page})=>{
    await fixture(page); await page.goto('/admin-panel/tasks');
    for(let i=0;i<3;i++) {
      await page.getByRole('button',{name:'Open navigation menu'}).tap();
      await expect(page.locator('#mobileNav')).toHaveClass(/show/);
      await page.locator('#mobileNav').getByRole('button',{name:'Close',exact:true}).tap();
      await expect(page.locator('#mobileNav')).not.toHaveClass(/show/);
      await page.getByRole('button',{name:'Reject task',exact:true}).tap();
      await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).tap();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await scrollUnlocked(page);
    }
  });
});
