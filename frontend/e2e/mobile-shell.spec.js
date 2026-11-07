import {test,expect} from '@playwright/test';
import {mobileWidths,shellFixture,pageOverflow,swipe} from './helpers/mobile-shell-fixture.js';

for(const width of [...mobileWidths,1440])test(`${width}px dashboard, admin forms and store layouts with long values`,async({page})=>{
  await page.setViewportSize({width,height:740});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await shellFixture(page,{role:'super_admin'});
  for(const [path,title] of [['/admin-panel/stores','Stores'],['/admin-panel/users?role=super_admin','Super Admins'],['/admin-panel/users/target',null],['/admin-panel/users/target/edit','Edit User'],['/admin-panel/users/target/password',null],['/admin-panel/users/target/datasets',null],['/admin-panel/users/add?role=super_admin','Add Super Admin']]){
    await page.goto(path);await expect(page.locator('.content-wrap h1')).toBeVisible();
    if(title)await expect(page.locator('.content-wrap h1')).toContainText(title);
    await expect(page.locator('.content-wrap')).not.toContainText('Loading');
    const o=await pageOverflow(page);
    expect(o.documentWidth,JSON.stringify({path,...o})).toBeLessThanOrEqual(width+1);
    expect(o.offenders,JSON.stringify({path,...o})).toEqual([]);
  }
  expect(errors).toEqual([]);
});

for(const width of mobileWidths)test(`${width}px real touch scrolling after drawer and browser history`,async({page})=>{
  await page.setViewportSize({width,height:640});await shellFixture(page);await page.goto('/dashboard');
  await expect(page.locator('.crm-dashboard')).toBeVisible();
  const o=await pageOverflow(page);expect(o.offenders,JSON.stringify(o)).toEqual([]);
  await swipe(page,{x:Math.floor(width/2),y:540,toY:200});
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(50);
  await page.evaluate(()=>scrollTo(0,0));
  for(let n=0;n<3;n++){
    await page.getByRole('button',{name:'Open navigation menu'}).click();
    await expect(page.locator('#mobileNav')).toHaveClass(/\bshow\b/);
    await swipe(page,{x:Math.floor(width*.5),y:500,toY:170});
    await expect.poll(()=>page.locator('#mobileNav .offcanvas-body').evaluate(e=>e.scrollTop)).toBeGreaterThan(20);
    await page.locator('#mobileNav .offcanvas-header .btn-close').click();
    await expect(page.locator('#mobileNav')).not.toHaveClass(/\bshow\b|showing|hiding/);
    await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
    await swipe(page,{x:Math.floor(width/2),y:540,toY:200});
    await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(50);
    await page.evaluate(()=>scrollTo(0,0));
  }
});

test('orphaned mobile body lock recovers on restore, active drawer remains locked',async({page})=>{
  await page.setViewportSize({width:358,height:668});await shellFixture(page);await page.goto('/dashboard');
  await expect(page.locator('.crm-dashboard')).toBeVisible();
  // Recreate the exact state observed in the user's running mobile dashboard.
  await page.evaluate(()=>{document.body.style.overflow='hidden';document.body.style.paddingRight='15px';window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
  expect(await page.locator('body').evaluate(e=>e.style.paddingRight)).toBe('');
  await swipe(page,{x:175,y:560,toY:210});await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(50);
  await page.getByRole('button',{name:'Open navigation menu'}).click();
  await expect(page.locator('#mobileNav')).toHaveClass(/\bshow\b/);
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await expect(page.locator('body')).toHaveCSS('overflow','hidden');
  await page.setViewportSize({width:1440,height:800});
  await expect(page.locator('#mobileNav')).not.toHaveClass(/\bshow\b|showing|hiding/);
  await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
});

test('native photo and review overlays release scroll ownership in either close order',async({page})=>{
  const harnessErrors=[];
  page.on('pageerror',e=>harnessErrors.push(e.message));
  await page.setViewportSize({width:390,height:600});
  await page.route('**/mobile-overlay-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="padding-right:4px"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
    import React from '/node_modules/.vite/deps/react.js';import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
    const {default:ConfirmationDialog}=await import('/src/components/ConfirmationDialog.jsx');const {default:ImagePreviewDialog}=await import('/src/components/ImagePreviewDialog.jsx');
    import '/src/styles/app.css';import '/src/styles/luxe-theme.css';import '/src/styles/mobile-shell.css';
    function Host(){const[review,setReview]=React.useState(false),[image,setImage]=React.useState(false);window.closeReview=()=>setReview(false);
      return React.createElement('div',{style:{minHeight:1800}},React.createElement('button',{onClick:()=>setReview(true)},'Open review'),
        React.createElement(ConfirmationDialog,{open:review,title:'Review evidence',actionLabel:'Approve',onCancel:()=>setReview(false),onConfirm:()=>setReview(false),details:React.createElement('button',{onClick:()=>setImage(true)},'Preview evidence')}),
        image&&React.createElement(ImagePreviewDialog,{images:[{label:'Before',original_name:'Synthetic evidence',url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}],onClose:()=>setImage(false)}));}
    ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(Host));</script></body></html>`}));
  await page.goto('/mobile-overlay-test');
  await expect(page.getByRole('button',{name:'Open review',exact:true}),harnessErrors.join('\n')).toBeVisible({timeout:7000});
  for(const closeParentFirst of [false,true]){
    await page.getByRole('button',{name:'Open review',exact:true}).click();
    await page.getByRole('button',{name:'Preview evidence',exact:true}).click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    if(closeParentFirst)await page.evaluate(()=>window.closeReview());
    else await page.getByRole('button',{name:'Close image preview'}).click();
    await expect(page.locator('body')).toHaveCSS('overflow','hidden');
    if(closeParentFirst)await page.getByRole('button',{name:'Close image preview'}).click();
    else await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(page.locator('body')).not.toHaveCSS('overflow','hidden');
    expect(await page.locator('body').evaluate(e=>e.style.paddingRight)).toBe('4px');
  }
  await swipe(page,{x:190,y:500,toY:180});await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(50);
});

for(const width of mobileWidths)test(`${width}px login and recovery remain usable at reduced height`,async({page})=>{
  await page.setViewportSize({width,height:500});await shellFixture(page,{signedIn:false});await page.goto('/login');
  await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  await page.getByLabel('Username or email').fill('Mobile.test@example.test');
  await page.getByLabel('Password',{exact:true}).fill('Synthetic-password');
  const o=await pageOverflow(page);expect(o.offenders,JSON.stringify(o)).toEqual([]);
  await page.getByRole('button',{name:'Forgot password?'}).click();
  await expect(page.getByRole('heading',{name:'Reset password'})).toBeVisible();
  const submit=page.getByRole('button',{name:'Email password-reset link'});await submit.scrollIntoViewIfNeeded();
  const box=await submit.boundingBox();expect(box.height).toBeGreaterThanOrEqual(44);
  expect((await pageOverflow(page)).offenders).toEqual([]);
});
