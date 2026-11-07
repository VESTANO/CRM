import {test,expect} from '@playwright/test';
import {mobileWidths,shellFixture,pageOverflow} from './helpers/mobile-shell-fixture.js';
for(const width of [...mobileWidths,1440])test(`${width}px password setup and status pages fit and retain validation`,async({page})=>{
  await page.setViewportSize({width,height:500});const app=await shellFixture(page);
  await page.goto('/login#type=recovery');
  await expect(page.getByRole('heading',{name:'Set your password'})).toBeVisible();
  await page.getByLabel('New password',{exact:true}).fill('Synthetic-password-A');
  await page.getByLabel('Confirm password',{exact:true}).fill('Synthetic-password-B');
  await page.getByRole('button',{name:'Save password and open CRM'}).click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  expect((await pageOverflow(page)).offenders).toEqual([]);
  for(const [path,title] of [['/offline','No internet connection'],['/500','Something went wrong'],['/not-a-crm-page','Page not found']]){
    await page.goto(path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    expect((await pageOverflow(page)).offenders,{path,width}).toEqual([]);
    const button=page.getByRole('button',{name:path==='/not-a-crm-page'?'Go back':'Try again',exact:true});
    await button.scrollIntoViewIfNeeded();const box=await button.boundingBox();
    if(width<=768)expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(app.mutations.some(path=>path.includes('/auth/v1/user'))).toBe(false);
});
