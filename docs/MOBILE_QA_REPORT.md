# VESTANO CRM — mobile UI audit

Date: 7 November 2026, Asia/Kolkata. Scope: the current local React/Vite application, its existing routes, shared overlays and role-specific screens, followed by the user's separately authorized isolated mobile UI release. No Supabase production configuration change or production business-data mutation was performed. Existing backend calculations, spreadsheet preservation, approval rules and database permissions were retained.

## Test environment and boundaries

- Requested mobile/tablet widths: **320, 360, 375, 390, 414, 430 and 768 px**.
- Desktop regression width: **1440 px**, plus the existing suite's 1024 px checks.
- Regular viewport heights include 640, 740 and 844 px. Reduced-height cases use **420, 430 and 500 px** to check scrollable content and reachable actions. This simulates reduced space; it is not proof of actual OS keyboard behavior.
- Tests run the actual React components/router/providers in Chromium. Page/role/data responses are explicitly synthetic and restricted to loopback; remote HTTP requests are blocked by the mobile fixtures. Production functionality was not replaced with mock application implementations.
- Real input cases include long unbroken names/emails/filenames/notes, maximum-sized money strings, declared large customer/sales totals, actual canvas-generated image selection/compression, validation failures and multiple role contexts.
- Actual CDP touch gestures exercise vertical document/drawer/modal scrolling, horizontal table/tab scrolling and image controls. Programmatic scroll alone is not treated as touch proof.
- The user's already running dashboard was inspected read-only at **358×668 px** to diagnose the reported lock. No customer field, status, account or provider action was submitted there.

## Confirmed issues and fixes

| ID | Severity | Reproduction / root cause | Implemented correction and evidence |
|---|---|---|---|
| MOB-001 | High | The running local mobile dashboard's body had inline `overflow: hidden; padding-right: 15px` while no drawer, backdrop or dialog was open. The document was 2,512 px tall but locked. Drawer, CRM dialog and native image dialog previously had independent save/restore mechanisms | All three now use one reference-counted scroll owner set. Bootstrap drawer scrolling is configured so it does not maintain a competing body snapshot. Recovery clears an orphan only when no active owner/overlay exists. Active overlays stay locked; closing in either order restores padding/scroll. The local dashboard subsequently had no inline lock and vertical overflow was visible. The precise earlier user-action sequence causing that stale state was not reconstructed |
| MOB-002 | Medium | SPA navigation from a scrolled customer list opened detail at the previous Y=534, hiding the heading. Back correctly retained the list position | Path changes on PUSH/REPLACE reset before paint. POP and same-page query/filter changes are left alone. Actual touch/navigation regression is **534 → 0 → 534** |
| MOB-003 | Medium | Mobile controls measured 32–42 px high; shared close targets were approximately 23–30 px square. Login recovery action, task review, reminders, attendance filters and photo controls were affected | Scoped phone/tablet target sizes reach 44 px for the audited controls, with nonshrinking 44×44 close buttons. Form controls use readable 16 px mobile text. Desktop dimensions remain governed by existing desktop styles; there is no blanket global button rewrite |
| MOB-004 | Medium | Unbroken valid imported text made customer, callback, sales and dataset tables thousands of pixels wide, requiring excessive swiping. Example sales scroll width: 24,967 px on a phone | Only marked business tables bound/wrap long text cells and notes. All columns, actions and full text remain available inside their horizontal scroll region. Representative 320 px after widths: customers 7,851→1,992; datasets 4,371→1,420; dataset detail 10,317→1,647; callbacks 10,557→1,508; sales 24,967→2,480 px. Wide tables intentionally retain contained horizontal scrolling; the page itself does not scroll sideways |
| MOB-005 | Medium | Large report counts split around commas in narrow breakdown rows; fixed 28 px trend markers could not hold large values | Mobile breakdown rows reserve a full readable count column. Large-count trends use compact markers plus a full month/value legend, preserving all values; ordinary charts retain their prior presentation |
| MOB-006 | Medium | At 768 px the Sales expense value required 189 px inside a 133 px cell, clipping a valid large amount | The scoped tablet Sales grid gives its expense card a full row while retaining the three count cards. Phone and wide-desktop layouts are preserved |
| MOB-007 | Medium | Callback outcome/date and administrator target/task dialogs did not consistently use the shared focus/body-lock lifecycle; short screens needed a contained scrollable body | These dialogs reuse the shared hook and scrollable structure. Focus is contained/restored, Escape/cancel works, and footer actions remain reachable at 420 px height. No new independent scroll-lock implementation was added |
| MOB-008 | Medium | At 320×430 px a long photo filename and gallery content pushed Close above the viewport when the footer was scrolled into view | A mobile flex layout keeps header/footer visible together, lets the full filename scroll within its header area and lets the image fit the remaining space. Close/Next remain simultaneously visible after photo navigation; image data/resolution is unchanged |
| MOB-009 | Low | Profile image upload had no associated visible label | Added an explicit label/input association; upload, preview, save and removal remain available |
| MOB-010 | Medium | Long profile names, department/email values and task text needed bounded wrapping; dense attendance/task/reminder forms had undersized controls | Component-scoped wrappers/styles contain long values, preserve table scrolling and enlarge controls. No field or feature was removed |
| MOB-011 | Medium | Super Admin employee-management controls were shown without a selected store, where the existing employee-read guard refuses access; a selected-store Super Admin instead received a read-only view | Live Super Admin role detection is independent of store selection, while employee management requires the selected store. Unscoped users receive an Open Stores prompt and make zero employee-list requests; scoped Super Admins can manage that store. Store Admins remain read-only. Existing read/API/RLS guards and fallback behavior are unchanged |
| MOB-012 | Low | Visit-form select/textarea controls lacked reliable label associations during mobile form inspection | Added stable IDs/label associations without changing submission fields or validation rules |

The shared fixes are scoped to the CRM shell, named dialogs and phone/tablet media queries. Module styles are `mobile-business.css`, `mobile-attendance.css` and `mobile-tasks.css`; they use specific component/table classes. No broad rule hides columns, suppresses vertical scrolling, removes overlays indiscriminately or reduces permissions to make a page fit.

## Pages and states audited

The matrix includes the seven requested widths and 1440 px unless a special height/state is explicitly noted. Not every URL below is a separate product feature; several are variants of shared components.

| Area | Routes / states | Checks |
|---|---|---|
| Authentication | `/login`, recovery-email form, password-setup gate | Long inputs, password fields, mismatch validation, action reachability, reduced height, no real password/email request |
| Status/loading/error | `/offline`, `/500`, unknown-route fallback; module loading/retry states | Contained cards, readable messages, reachable retry/back controls; offline draft recovery retained by existing regression |
| Dashboard | `/dashboard`, targets, large KPI/payment strings, recent datasets, sales cards | Touch page scrolling, chart/card fit, header/menu, long content, stable layout and no page overflow |
| Customers/leads | `/customers`, `/datasets/:datasetId/customers/:id`, edit/delete variants | Long names/original fields/history/notes, five-status controls, contained tables, callback date dialog, forward/back scrolling |
| Datasets/import | `/datasets`, `/datasets/:id`, rename/delete variants, `/import` | Long filenames, column/preview tables, status tabs, form controls, file-selection UI and preserved actions |
| Callbacks | `/callbacks`, outcome/date dialogs | Filters, counts, table swipes, cancel/final-outcome controls, focus and 420 px modal scroll |
| Sales/visits | `/sales`, add/edit/detail/delete visit routes | Long clients/notes/money, payment fields, native dates, 768 px expense card, image gallery and touch controls |
| Reports/targets | `/reports`, dataset/dashboard target cards, administrator target dialog | Full large values, legends/breakdowns, form labels, target selection and contained scrolling |
| Tasks/approvals | `/notifications`, `/admin-panel/tasks`, administrator assignment dialog | Required rejection feedback, approve/cancel once, notification read UI, image evidence/preview/compression, resubmission and action targets |
| Timesheets | `/attendance/timesheet`, `/attendance/approvals` | New/prefilled daily entry, reduced-height form, submit, approval/rejection, delete confirmation, focus/scroll release |
| Overtime | `/attendance/overtime`, `/overtime` shared panel | Employee request and admin review variants, required reason, approve/reject/cancel, role-specific controls |
| Attendance | `/attendance`, `/attendance/overview` | Employee/date controls, long rows, export actions, table swiping, inline Super Admin eSSL/mapping controls, unavailable/retry state |
| Employees | `/attendance/employees` | Global/scoped/store-admin variants, inline create/edit and password visibility, inactive deletion confirmation |
| Profile/settings | `/attendance/profile` and inline eSSL configuration/mapping | Long values, labeled photo upload/save/remove, local OTP feedback and role restrictions. There is no separate Settings route or settings popup |
| Store/Super Admin | `/admin-panel/stores`, user directory/global directory, user detail/add/edit/password/datasets routes | Store cards/action rows, long names/email, forms/selects/password controls, table bounds and seven mobile widths plus desktop |
| Reminders/alerts | `/reminders`, notification badges/alerts/inbox | Long text, due/upcoming controls, edit/validation, notification permission failure feedback, touch sizes |

Business geometry evidence covers **17 routes × 8 widths = 136 page/width records**. The initial attendance matrix covered 72 layout states, 63 at mobile widths, and measured 462 mobile controls with a minimum 44×44 px target; additional approve/delete/scoped-access variants are included in the final suite. These counts overlap with the broader scenario tests and are not unique user journeys or performance capacity measurements.

## Scroll, dialog and permission regression details

- Repeated touch swipes move the document and the long mobile drawer; close/navigation returns scrolling to the page. Enlarged sidebar groups and lower logout controls remain reachable.
- An explicit recovery test recreates the observed orphan state and emits a browser restore event. The page unlocks; the same event while a valid drawer is open does not unlock it. Moving to the desktop breakpoint closes the mobile drawer cleanly.
- Real ConfirmationDialog and ImagePreviewDialog instances share a test host. Child-first and parent-first closing both preserve the remaining owner's lock, then restore the original padding and document scroll on final close.
- Native photo preview, callback date/outcome, target/task assignment, new/edit daily work, approve/reject and delete confirmations are exercised. Keyboard focus, Escape, feedback retention, reachable actions and body unlock are checked; native picker internals require devices.
- Scoped employee deletion includes the selected-store header; unscoped Super Admin and read-only Store Admin checks remain negative tests. Employee OT views do not gain review controls. No API, database or RLS policy was relaxed.
- Same-page filters keep their position. New route headings start at the top. Browser Back restores the prior list position rather than forcing every navigation to zero.

Earlier test failures were separated from application defects: swiping during `.showing` rather than after `.show`, a decoder-invalid tiny PNG, a fixture response ordering error, an unscoped employee fixture inconsistent with the real store guard, and a CJS import in an isolated overlay harness were corrected. They are not reported as production bugs or counted as passing attempts. The orphaned live lock, control dimensions, excessive table widths, chart/card clipping and scope/UI contradiction were independently observed/reproduced.

## Test commands and evidence

From `frontend` in the full local QA workspace (these pending QA scripts are not all transplanted into the minimal live UI release):

```text
npm test
npm run test:db
npm run test:e2e
npm run test:mobile
npm run build -- --mode pages
```

The regular browser suite excludes `mobile-*.spec.js`; the dedicated mobile configuration includes all shell/auth/business/attendance/task specs and uses one loopback server with one worker. The local candidate's pending CI workflow includes it and collects the mobile artifacts; that broader workflow is excluded from the isolated live UI release.

Evidence is generated under `tmp/mobile/`, `tmp/mobile-business/` and `tmp/mobile-tasks/`: JSON results, per-width geometry, before/after measurements, touch/history records, screenshots and retained failure traces. Photo short-viewport before/after images are preserved separately. Temporary artifacts can be regenerated and should be retained with the reviewed release candidate when needed.

The final local source run completed successfully: **85/85 mobile browser tests** (8.6 minutes), **35/35 existing browser tests**, **234 unit tests**, and **82 isolated database checks** passed. The production Pages build passed (291 modules). The database checks operate on local isolated test databases and are not proof of production database state. These totals describe the complete local QA candidate; the separately isolated live UI release is verified below against its preserved remote backend contract.

## Remaining blockers and real-device checks

1. No physical Android Chrome, iOS Safari, tablet or biometric device was connected. Chromium viewport/touch emulation and the in-app browser inspection are not physical-device results.
2. Test native keyboard opening/closing, visual viewport movement, input zoom, date/time/select/file pickers, Android Back behavior, orientation, safe areas, browser address-bar expansion and inertia/overscroll on actual supported devices. Reduced-height tests do not establish those OS behaviors.
3. Test real camera/gallery permissions, large camera photos/HEIC conversion, memory pressure, upload interruption, screen-reader announcements and native image/attachment workflows. Synthetic canvas images verify the existing browser pipeline, not every phone codec.
4. Real push/OTP/mail delivery, closed-browser notifications, hosted realtime and Storage/Supabase integration remain unverified without the staging/provider/device setup. Local mutation assertions are not delivery evidence.
5. Broad screen-reader, Firefox and real Safari/WebKit coverage remain outstanding. Desktop Chromium at 1440 px and the existing regression widths provide the executed desktop evidence.
6. Existing whole-history/export capacity and arbitrary-field/deep-page query limits from the engineering audit remain. This UI pass introduces no generic loading screens, polling/automatic refresh, backend redesign or claim that all large-data device memory limits are solved.

The overall engineering assessment remains **CONDITIONAL READY** wherever hosted/provider or physical verification is incomplete. The user subsequently authorized a mobile UI release so they can verify scrolling on a real phone. That authorization does not include the pending backend, authentication, database or infrastructure work.

## Isolated live UI release

The mobile deployment is prepared in `tmp/mobile-ui-live`, based on remote `origin/main` commit `9af78706cd805fac52574b07fcd37b1cf0944e30`. The root workspace also contains an unpublished store-boundary commit and substantial Phase 1–5 changes. They are excluded from this deployment. Mobile styles, shared scroll/focus handling and associated presentation fixes are ported separately to preserve the existing live API contract.

No services/API implementations, authentication providers, login/password flows, environment values, Supabase functions, SQL migrations, attendance calculations, spreadsheet persistence, production dependencies or deployment infrastructure are included. Existing native approval/delete behavior is retained where replacing it would also import pending workflow changes. The root candidate's MOB-011 employee role/control correction is excluded from the isolated release to preserve the remote role behavior.

Independent release-boundary checks confirmed no changes under services, authentication providers, backend, Supabase, package/lockfiles, Vite configuration or deployment workflows. All **92 service-call expressions** in the changed JSX files match the baseline's callee and argument ASTs. Separate attendance and business checks also compare existing role predicates, effects, state initialization, financial/date calculations and mutation handlers. These are source compatibility checks, not proof of hosted data correctness.

The isolated release uses a fresh `npm ci` from the unchanged production lockfile. Its Pages build passed with **286 modules** (`npm run build -- --mode pages --base /`), and all **39 existing deployment checks** passed. A broader unchanged-baseline unit run returned **136 passed / 6 failed**: all six failures are in the existing `admin-user.test.mjs` extraction harness, which omits `isSuperAdmin` from its evaluated handler environment. The helper is present in the full handler; neither that handler nor its test was changed by this release. The preserved production dependency install also reports three existing high-severity advisory findings; the pending dependency/security upgrades remain outside this UI-only deployment.

Release browser checks use `scripts/mobile-release-playwright.config.mjs`, with adapted business/task/attendance fixtures matching the remote API contract and unchanged native approval/deletion prompts. Artifacts are `tmp/mobile/release-results.json`, `tmp/mobile/release-artifacts/` and `tmp/mobile-business-release/`. They are separate from the broader local QA run. No live business record is created, edited, deleted or reset during verification.

All **69 release browser scenarios** passed across the seven requested widths and 1440 px desktop: the first run returned 68 passes and one lazy-route readiness timeout at 320 px; the unchanged UI passed that targeted retest with a 15-second readiness allowance. The original trace is retained, and the passing retest is `tmp/mobile/release-retest-results.json`. This is not reported as a clean 69-pass first run. The matrix includes 136 business page/width geometry records, native attendance/timesheet/OT contracts, task evidence, nested overlays, real touch scrolling, short dialogs and browser history.

The release commit uses `[skip render]`, which [Render documents as skipping its automatic deployment](https://render.com/docs/deploys#skipping-an-auto-deploy). This prevents the older Render blueprint's backend/pre-deploy migration command from being triggered by this UI publication without altering infrastructure configuration. The existing GitHub Pages frontend workflow remains unchanged. Hosted publication is checked after the push; no production account is used or business data submitted by the smoke checks. Physical-device and authenticated hosted workflow verification remain **CONDITIONAL READY**.

### Hosted publication result

The isolated UI commit **`19aa5241320aa9408c9429846aae7b9e0ec76c34`** was pushed to `main`. The existing [GitHub Pages deployment](https://github.com/VESTANO/CRM/actions/runs/42350306276) completed successfully and serves [VESTANO CRM](https://vestano.online/). The release checkout is clean. Its 29 changed files comprise frontend presentation/scroll/focus code and this report; the protected backend/API/authentication/dependency/configuration diff is empty. The broader unpublished QA changes remain in the original workspace.

Post-deployment anonymous browser smoke checks passed **8/8** at 320, 360, 375, 390, 414, 430, 768 and 1440 px. The actual hosted CSS contains the new scroll/dialog styles, all requested JS/CSS assets succeeded, the login view has no horizontal overflow, and no JavaScript page errors occurred. Mobile submit targets measure 44 px and input text measures 16 px; desktop controls retain their desktop sizing. Every data-changing HTTP request was blocked by the smoke harness, none was attempted, and no authenticated session was used. Evidence: `tmp/mobile/live/results.json`, `tmp/mobile/live/login-390.png` and `tmp/mobile/release-manifest.json`.

No production customer, attendance punch, uploaded timesheet, account, role, login ID or password was edited or reset by this work. No Supabase function or SQL migration was deployed. Authenticated hosted workflows and physical phone scrolling/keyboard behavior still require the user's/device checks; this publication does not remove the **CONDITIONAL READY** qualification from those checks.

### Attendance approval popup follow-up

The user identified a remaining usability issue on the hosted `/attendance/approvals` page: selecting **Review** opened an inline form above the table and shifted the page. The review now opens in a centered modal with a dimmed backdrop. The employee/date/work details and existing optional comment remain visible; the modal body scrolls on short screens while the header and Approve, Reject and Cancel actions stay reachable. Closing returns focus and scrolling to the table. Duplicate decision clicks are disabled while the original review request is pending.

The approval service call, status values and comment payload remain unchanged. The isolated browser fixture verified cancellation without a write, rejection with the exact comment, approval, short-height containment and scroll release at **320, 360, 375, 390, 414, 430, 768 and 1440 px: 8/8 passed**. The first iteration exposed clipping with very long details at 420 px height; a bounded dialog and scrolling body corrected it. The production Pages build and existing deployment checks remain required for the follow-up commit. Physical keyboard and authenticated hosted interaction still need a real-device check.

Follow-up commit **`4e9033de62510818a8565d6177efce99eb1fb35d`** was pushed. The [Pages build and deployment](https://github.com/VESTANO/CRM/actions/runs/42351594312) completed successfully. The live attendance JavaScript and its separately loaded CSS both return HTTP 200 and include the new popup code/styles. Anonymous live layout checks passed **8/8 widths** with all data-changing requests blocked. An authenticated browser and physical phone still need to confirm the interaction with actual entries; no production approval was submitted during QA.

### Password visibility follow-up

The user reported that the eye control on `/login` revealed the password only while hovering or holding it. The shared `PasswordInput` now toggles on click, tap or keyboard activation and remains in that state until clicked again. The control exposes `aria-pressed` and changes its accessible name between **Show password** and **Hide password**. This applies consistently to sign-in, password setup and administrator password forms. Login values, requests and account credentials are unchanged.

Synthetic browser checks passed at **320, 360, 375, 390, 414, 430, 768 and 1440 px**. They verify tap/click, persistence after moving focus, second-click hiding, and zero network mutations. A separate password setup check verified keyboard activation and independent visibility of its two fields. The production Pages build passed. No real password was read or entered during QA.
