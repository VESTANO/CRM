import { test, expect } from '../frontend/node_modules/@playwright/test/index.mjs';
const id='00000000-0000-4000-8000-000000000001';
const long='DisplayChecklistReference'.repeat(8);
const longNote=`Review the first section carefully.\n${long}\nKeep the evidence and feedback readable.`;
const photo=n=>({id:n,original_name:`${long}-${n}.png`,url:`http://127.0.0.1:54321/storage/v1/qa/photo-${n}.png`,thumbnail_url:`http://127.0.0.1:54321/storage/v1/qa/photo-${n}.png`});

async function fixture(page,{role='admin'}={}) {
  const encodedImage=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=80;canvas.height=80;const context=canvas.getContext('2d');context.fillStyle='#e1ad64';context.fillRect(0,0,80,80);return canvas.toDataURL('image/png').split(',')[1];});
  const imageBytes=Buffer.from(encodedImage,'base64');
  const profile={id,employee_id:'MOBILEQA',name:'Local UI reviewer',email:'mobile@example.test',role,active:true,store_id:'00000000-0000-4000-8000-000000000011'};
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const session={access_token:`${encode({alg:'HS256'})}.${encode({sub:id,role:'authenticated',exp:4070908800})}.local-only`,refresh_token:'synthetic-refresh',token_type:'bearer',expires_at:4070908800,user:{id,email:profile.email,aud:'authenticated',role:'authenticated',user_metadata:{}}};
  const submission={id:11,status:'submitted',submitted_at:'2026-11-07T09:00:00Z',note:longNote,images:[photo(3),photo(4)]};
  const previous={id:10,status:'rejected',submitted_at:'2026-11-06T09:00:00Z',reviewed_at:'2026-11-06T10:00:00Z',review_note:longNote,reviewed_by_username:long,note:longNote,images:[photo(5)]};
  const task={id:1,title:long,assignee:id,assignee_username:long,assigned_by_username:long,note:longNote,created_at:'2026-11-01T09:00:00Z',due_at:'2026-11-02T09:00:00Z',status:role==='admin'?'submitted':'rejected',assignment_images:[photo(1),photo(2)],completion_images:submission.images,current_submission:role==='admin'?submission:previous,submissions:role==='admin'?[previous,submission]:[previous]};
  let notifications=[{id:1,task_id:1,title:long,message:longNote,created_at:'2026-11-07T09:00:00Z',read_at:null}];
  const reminders=[{id:1,text:long,reminder_at:'2099-01-01T12:00:00Z',notification_status:'Delivery scheduled',last_delivery_error:long},{id:2,text:`Due ${long}`,reminder_at:'2000-01-01T12:00:00Z',notification_status:'Due'}];
  const requests=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),session);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*'};
    if(method==='OPTIONS')return route.fulfill({status:204,headers});
    if(path.startsWith('/storage/'))return route.fulfill({contentType:'image/png',body:imageBytes,headers});
    if(method!=='GET')requests.push({path,body:request.headers()['content-type']?.includes('application/json')?request.postDataJSON():request.postData()});
    let payload={};
    if(path.includes('/auth/v1/user'))payload=session.user;
    else if(path.includes('/auth/v1/token'))payload=session;
    else if(path.includes('/rest/v1/profiles'))payload=[profile];
    else if(path.endsWith('/task-notifications/'))payload={results:notifications,unread_count:notifications.filter(n=>!n.read_at).length};
    else if(path.includes('/task-notifications/')) {notifications=notifications.map(n=>({...n,read_at:'2026-11-07T12:00:00Z'}));payload={};}
    else if(path.endsWith('/admin/tasks/')||path.endsWith('/tasks/'))payload={results:[task]};
    else if(path.endsWith('/admin/tasks/1/')) {task.status=request.postDataJSON().review_action==='approve'?'done':'rejected';payload=task;}
    else if(path.endsWith('/tasks/1/')) {task.status='submitted';payload=task;}
    else if(path.endsWith('/reminders/'))payload={results:reminders};
    else if(path.endsWith('/reminders/1/')){Object.assign(reminders[0],request.postDataJSON());payload=reminders[0];}
    else if(path.endsWith('/dashboard/'))payload={totalDatasets:0,totalCustomers:0,responseStats:[],recentDatasets:[],payments:{},sales:{}};
    else if(path.endsWith('/targets/'))payload={results:[]};
    return route.fulfill({json:payload,headers});
  });
  return {requests,errors,imageBytes};
}

async function noPageOverflow(page,label) {
  const overflow=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,
    offenders:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+2&&!el.closest('.table-responsive')).slice(0,8).map(el=>({tag:el.tagName,class:el.className,right:Math.round(el.getBoundingClientRect().right)}))}));
  expect.soft(overflow.width,`${label}: ${JSON.stringify(overflow.offenders)}`).toBeLessThanOrEqual(overflow.viewport+1);
}
async function touchTarget(locator,label) {
  const box=await locator.boundingBox();expect.soft(box?.height,`${label} height`).toBeGreaterThanOrEqual(44);expect.soft(box?.width,`${label} width`).toBeGreaterThanOrEqual(44);
}
async function screenshot(page,testInfo,name,options={}) {
  const path=testInfo.outputPath(name);await page.screenshot({path,...options});
  await testInfo.attach(name,{path,contentType:'image/png'});
}

for(const width of [320,360,375,390,414,430,768,1440])test(`${width}px task reviews, notifications, photos and reminder editing`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:800});const app=await fixture(page);
  await page.goto('/notifications');await expect(page.getByRole('heading',{name:'Task reviews',exact:true})).toBeVisible();
  await noPageOverflow(page,'Notifications long text');
  if(width<=768)await touchTarget(page.getByRole('button',{name:'Mark all as read',exact:true}),'Mark all as read');
  await page.getByText('Previous submissions (1)',{exact:true}).click();
  if(width<=768)await touchTarget(page.getByText('Previous submissions (1)',{exact:true}),'Previous submissions');
  await expect(page.getByText('Rejection note:',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/Open Before photo 1:/}).click();
  const preview=page.getByRole('dialog');await expect(preview).toBeVisible();
  await expect(preview.locator('.task-image-full')).toHaveJSProperty('naturalWidth',80);
  if(width<=768){await touchTarget(preview.getByRole('button',{name:'Close image preview'}),'Close image preview');await touchTarget(preview.getByRole('button',{name:'Next image',exact:true}),'Next image');}
  expect.soft(await preview.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Image preview content fits').toBe(true);
  await preview.getByRole('button',{name:'Next image',exact:true}).click();await expect(preview.getByText('2 / 2',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(preview).not.toBeVisible();
  const reject=page.getByRole('button',{name:'Reject task',exact:true});if(width<=768)await touchTarget(reject,'Reject task');
  await reject.click();const dialog=page.getByRole('dialog',{name:'Reject task submission?'});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Confirm rejection',exact:true})).toBeDisabled();
  await dialog.getByLabel('Rejection feedback').fill('Please correct this section and send a clearer photo.');
  expect.soft(await dialog.locator('.modal-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Long review details fit dialog').toBe(true);
  await screenshot(page,testInfo,`review-${width}.png`);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(reject).toBeFocused();
  await page.getByRole('button',{name:'Mark all as read',exact:true}).click();
  await expect(page.getByRole('button',{name:'Mark all as read',exact:true})).not.toBeVisible();
  await page.goto('/admin-panel/tasks');await expect(page.getByRole('heading',{name:'Assigned Tasks',exact:true})).toBeVisible();
  await expect(page.locator('.admin-tasks-table')).toBeVisible();await noPageOverflow(page,'Admin task table contained scrolling');
  await page.goto('/reminders');await expect(page.getByRole('heading',{name:'Your reminders',exact:true})).toBeVisible();
  await noPageOverflow(page,'Reminder long text');
  if(width<=768){await touchTarget(page.getByRole('button',{name:'Edit reminder',exact:true}),'Edit reminder');await touchTarget(page.getByRole('button',{name:/Upcoming \(/}),'Upcoming filter');}
  await screenshot(page,testInfo,`reminders-${width}.png`,{fullPage:true});
  await page.getByRole('button',{name:'Edit reminder',exact:true}).click();await expect(page.getByRole('heading',{name:'Edit reminder',exact:true})).toBeVisible();
  await page.getByLabel('Reminder',{exact:true}).fill('Synthetic mobile reminder edit');await page.getByLabel('Date',{exact:true}).fill('2099-01-02');await page.getByLabel('Time',{exact:true}).fill('10:00');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByLabel('Reminder',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:/Due \(/}).click();await expect(page.getByText(`Due ${long}`,{exact:true})).toBeVisible();await noPageOverflow(page,'Due reminder');
  expect(app.requests.filter(r=>r.path.includes('/admin/tasks/1/'))).toHaveLength(0);expect(app.errors).toEqual([]);
});

test('390px employee rejection feedback, photo selection and resubmission remain usable',async({page})=>{
  await page.setViewportSize({width:390,height:700});const app=await fixture(page,{role:'employee'});await page.goto('/notifications');
  await expect(page.getByRole('heading',{name:'Task notifications',exact:true})).toBeVisible();await noPageOverflow(page,'Employee rejected task');
  await page.getByLabel('Resubmission note (optional)').fill(longNote);
  const submit=page.getByRole('button',{name:'Resubmit for review',exact:true});await touchTarget(submit,'Resubmit for review');await submit.click();
  await expect(page.getByRole('alert').filter({hasText:'Upload new After photos'})).toBeVisible();
  await page.getByLabel('New After photos (required)').setInputFiles({name:'synthetic-evidence.png',mimeType:'image/png',buffer:app.imageBytes});
  await expect(page.getByRole('button',{name:'Remove synthetic-evidence.png'})).toBeVisible();await noPageOverflow(page,'Selected evidence');
  await submit.click();await expect(page.getByRole('status').filter({hasText:'Awaiting admin approval.'})).toBeVisible();
  expect(app.requests.filter(request=>request.path.endsWith('/tasks/1/'))).toHaveLength(1);expect(app.errors).toEqual([]);
});

test('320px short viewport keeps photo/review controls reachable and approves once',async({page},testInfo)=>{
  await page.setViewportSize({width:320,height:430});const app=await fixture(page);await page.goto('/notifications');
  await page.getByRole('button',{name:/Open Before photo 1:/}).click();
  const preview=page.getByRole('dialog');await expect(preview).toBeVisible();
  const next=preview.getByRole('button',{name:'Next image',exact:true});await next.scrollIntoViewIfNeeded();
  const nextBox=await next.boundingBox();expect.soft(nextBox.y+nextBox.height,'Photo footer fits short viewport').toBeLessThanOrEqual(430);
  const close=preview.getByRole('button',{name:'Close image preview'});
  const closeBox=await close.boundingBox();
  expect.soft(closeBox.y,'Photo Close stays visible with the footer').toBeGreaterThanOrEqual(0);
  expect.soft(closeBox.y+closeBox.height,'Photo Close fits short viewport').toBeLessThanOrEqual(430);
  expect.soft(closeBox.x,'Photo Close fits horizontal bounds').toBeGreaterThanOrEqual(0);
  expect.soft(closeBox.x+closeBox.width,'Photo Close fits horizontal bounds').toBeLessThanOrEqual(320);
  expect.soft(nextBox.y,'Photo Next stays visible with Close').toBeGreaterThanOrEqual(0);
  await screenshot(page,testInfo,'image-short-after.png');
  await next.click();
  const afterNextClose=await close.boundingBox();
  expect.soft(afterNextClose.y,'Photo Close remains visible after navigation').toBeGreaterThanOrEqual(0);
  expect.soft(afterNextClose.y+afterNextClose.height).toBeLessThanOrEqual(430);
  await close.click();
  for(let index=0;index<2;index++) {
    await page.getByRole('button',{name:'Reject task',exact:true}).click();
    const review=page.getByRole('dialog',{name:'Reject task submission?'});await review.getByLabel('Rejection feedback').fill('Recheck this evidence.');
    const cancel=review.getByRole('button',{name:'Cancel',exact:true});await cancel.scrollIntoViewIfNeeded();
    const cancelBox=await cancel.boundingBox();expect.soft(cancelBox.y+cancelBox.height,'Review footer fits short viewport').toBeLessThanOrEqual(430);
    await cancel.click();await expect(review).not.toBeVisible();
    expect(await page.evaluate(()=>getComputedStyle(document.body).overflow)).not.toBe('hidden');
  }
  await page.getByRole('button',{name:'Approve task',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Confirm approval',exact:true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(app.requests.filter(request=>request.path.endsWith('/admin/tasks/1/'))).toHaveLength(1);
  expect(app.errors).toEqual([]);
});
