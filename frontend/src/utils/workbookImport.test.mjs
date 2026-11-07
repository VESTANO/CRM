import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { prepareWorkbook, uploadStagedImport } from './workbookImport.js';
const book=rows=>({SheetNames:['Leads'],Sheets:{Leads:XLSX.utils.aoa_to_sheet(rows)}});
test('duplicate/blank/non-Latin headings and fields beyond the header preserve all cells',()=>{
  const result=prepareWorkbook(XLSX,book([[' Name ','Name','Name_2','','客户'],['A','B','C','001','中文','extra']]));
  const s=result.sheets[0];
  assert.equal(new Set(s.field_keys).size,6);
  assert.equal(s.column_names[0],' Name ');
  assert.deepEqual(Object.values(s.records[0].original_data),['A','B','C','001','中文','extra']);
});
test('blank rows keep original row numbers and duplicate rows are reported, not deleted',()=>{
  const result=prepareWorkbook(XLSX,book([['Name'],['A'],[],['A']]));
  assert.deepEqual(result.sheets[0].records.map(r=>r.row_number),[2,4]);
  assert.equal(result.warnings.length,1);
  assert.throws(()=>prepareWorkbook(XLSX,book([['Name']])),/no non-empty/);
});
test('retry after network failure resends the same job and rows and never deletes a dataset',async()=>{
  const prepared=prepareWorkbook(XLSX,book([['Name'],['A']]));
  const pending={...prepared,fingerprint:'a'.repeat(64),datasetName:'QA',filename:'qa.xlsx'};
  let fail=true; const paths=[];
  const post=async path=>{paths.push(path); if(path.includes('/batch/')&&fail){fail=false;throw new Error('offline');} return {data:path==='/import/start/'?{id:'job'}:{dataset:{id:1}}};};
  await assert.rejects(uploadStagedImport(pending,post),/offline/);
  assert.equal((await uploadStagedImport(pending,post)).data.dataset.id,1);
  assert.deepEqual(paths,['/import/start/','/import/jobs/job/batch/','/import/start/','/import/jobs/job/batch/','/import/jobs/job/commit/']);
});
test('25,000-row XLSX round trip retains formatted values and count',()=>{
  const wb=book([['Name','Phone'],...Array.from({length:25000},(_,i)=>[`Synthetic ${i}`,'0001234567'])]);
  const bytes=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  const result=prepareWorkbook(XLSX,XLSX.read(bytes,{type:'buffer',cellDates:true}));
  assert.equal(result.total,25000); assert.equal(result.sheets[0].records.at(-1).original_data.phone,'0001234567');
});
test('offset header rows retain worksheet row numbers; uncached formulas are reported',()=>{
  const wb={SheetNames:['Offset'],Sheets:{Offset:XLSX.utils.aoa_to_sheet([['Name'],['Alice']],{origin:'B3'})}};
  assert.equal(prepareWorkbook(XLSX,wb).sheets[0].records[0].row_number,4);
  wb.Sheets.Offset.B4={t:'n',f:'1+1'};
  assert.throws(()=>prepareWorkbook(XLSX,wb),/formula has no saved value/);
});
