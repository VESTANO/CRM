import {chromium} from '../frontend/node_modules/@playwright/test/index.mjs';
import {shellFixture,swipe} from '../frontend/e2e/helpers/mobile-shell-fixture.js';
import {mkdirSync,writeFileSync} from 'node:fs';
const browser=await chromium.launch();const context=await browser.newContext({viewport:{width:320,height:640},hasTouch:true});
const page=await context.newPage();await shellFixture(page);await page.goto('http://127.0.0.1:5201/dashboard');
await page.getByRole('button',{name:'Open navigation menu'}).click();await page.waitForTimeout(400);
const inspect=()=>page.evaluate(()=>['#mobileNav','#mobileNav .offcanvas-body','#mobileNav .sidebar-menu-scroll'].map(selector=>{
 const e=document.querySelector(selector),s=getComputedStyle(e),r=e.getBoundingClientRect();return {selector,top:r.top,bottom:r.bottom,client:e.clientHeight,scroll:e.scrollHeight,scrollTop:e.scrollTop,flex:s.flex,overflow:s.overflow,touch:s.touchAction,position:s.position};
}));
const before=await inspect();await swipe(page,{x:155,y:500,toY:170});const after=await inspect();
mkdirSync('tmp/mobile',{recursive:true});writeFileSync('tmp/mobile/touch-sidebar-baseline.json',JSON.stringify({before,after},null,2));
await page.screenshot({path:'tmp/mobile/sidebar-before.png'});console.log(JSON.stringify({before,after},null,2));
await browser.close();
